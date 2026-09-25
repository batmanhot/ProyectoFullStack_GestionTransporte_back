import { Injectable } from '@nestjs/common'
import type { Trip } from '../../generated/prisma/client'
import { AppError, Errors } from '../../common/errors/app-error'
import { INCIDENT_CATEGORY, TRIP_LIFECYCLE } from '../../common/labels'
import { clean, parseDate } from '../../common/http/params'
import { IdempotencyService, requestHash } from '../../common/idempotency/idempotency.service'
import { PrismaService } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { IncidentsService } from '../incidents/incidents.service'
import { NotificationService } from '../notifications/notification.service'
import { MessagesService } from '../planning/messages.service'
import { TripsService } from '../planning/trips.service'

/** Checklist previo a la salida (SUPUESTO TÉCNICO: DOC-A no define ítems; configurable por negocio en una fase posterior). */
export const CHECKLIST = [
  { id: 'ck-1', label: 'Frenos y luces operativos', critical: true },
  { id: 'ck-2', label: 'Neumáticos en buen estado', critical: true },
  { id: 'ck-3', label: 'Extintor y botiquín presentes', critical: true },
  { id: 'ck-4', label: 'Documentos a bordo', critical: false },
  { id: 'ck-5', label: 'Equipo de comunicación funcionando', critical: false },
]
/** Vigencia de la copia offline de «mis viajes» (ADR-008): el servidor vence/revoca. SUPUESTO: una jornada. */
const CACHE_HOURS = 12

export type DriverActionType = 'checklist' | 'start' | 'incident' | 'arrival' | 'finish' | 'message'
export interface DriverActionRequest {
  tripId: string
  type: DriverActionType
  occurredAt: string
  payload: {
    checklist?: { itemId: string; ok: boolean; note?: string }[]
    incident?: { category: string; description: string; emergency: boolean }
    message?: { text: string }
    evidenceNames?: string[]
    evidenceFileIds?: string[]
    note?: string
  }
}
export interface DriverActionResult {
  status: 'Confirmada' | 'Rechazada'
  code?: string
  message?: string
  serverAt: string
}

/**
 * App del conductor (RF-027/028 · ADR-008 · FE-040). Alcance OWN_RECORDS: solo sus viajes.
 * Contrato offline: toda acción llega con `Idempotency-Key` (la misma en cada reintento del outbox). El servidor decide:
 * una respuesta «Rechazada» es DEFINITIVA y se guarda igual que una «Confirmada» (el reintento no cambia el resultado).
 * Nunca se despacha ni se reasigna desde la app (esas acciones no existen aquí).
 */
@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly trips: TripsService,
    private readonly incidents: IncidentsService,
    private readonly messages: MessagesService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  private async myDriverId(p: Principal): Promise<string | null> {
    return (await this.prisma.db.driver.findFirst({ where: { userId: p.userId }, select: { id: true } }))?.id ?? null
  }

  async myTrips(p: Principal) {
    const driverId = await this.myDriverId(p)
    if (!driverId) return []
    const rows = await this.prisma.db.trip.findMany({ where: { driverId, lifecycle: { in: ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO'] } }, orderBy: { plannedDeparture: 'asc' } })
    const routes = await this.prisma.db.route.findMany({ where: { id: { in: rows.map((t) => t.routeId) } }, select: { id: true, origin: true, destination: true } })
    const now = Date.now()
    return rows.map((t) => {
      const r = routes.find((x) => x.id === t.routeId)
      return {
        id: t.id, code: t.code, routeName: t.routeName, origin: r?.origin ?? '', destination: r?.destination ?? '',
        plannedDeparture: t.plannedDeparture.toISOString(), plannedEta: t.plannedEta.toISOString(), vehiclePlate: t.vehiclePlate ?? '—', instructions: t.instructions,
        lifecycle: TRIP_LIFECYCLE.label(t.lifecycle), checklist: CHECKLIST, cachedUntil: new Date(now + CACHE_HOURS * 3_600_000).toISOString(), syncedAt: new Date(now).toISOString(),
      }
    })
  }

  async submit(p: Principal, key: string | undefined, req: DriverActionRequest): Promise<DriverActionResult> {
    if (!key) throw Errors.field('Idempotency-Key', 'Las acciones del conductor requieren Idempotency-Key (outbox offline).')
    const scopeKey = this.idem.scopeKey(p.tenantId, p.userId, `driver:${key}`)
    const begun = await this.idem.begin(scopeKey, requestHash(req))
    if ('replay' in begun) return begun.replay.body as DriverActionResult
    try {
      const result = await this.run(p, req)
      await this.idem.complete(scopeKey, { status: 200, body: result })
      return result
    } catch (e) {
      await this.idem.release(scopeKey)
      throw e
    }
  }

  private async run(p: Principal, req: DriverActionRequest): Promise<DriverActionResult> {
    const serverAt = () => new Date().toISOString()
    const reject = async (code: string, message: string): Promise<DriverActionResult> => {
      await this.audit.recordSafe({ resourceType: 'Viaje', resourceId: req.tripId, action: `driver.${req.type}.rejected`, result: 'DENEGADO', after: `${code}: ${message}` })
      return { status: 'Rechazada', code, message, serverAt: serverAt() }
    }
    const occurredAt = parseDate(req.occurredAt) ?? new Date()
    const driverId = await this.myDriverId(p)
    const effects: (() => void)[] = []
    try {
      const out = await this.prisma.tx(async (tx): Promise<DriverActionResult | { reject: [string, string] }> => {
        const t: Trip | null = driverId ? await tx.trip.findFirst({ where: { id: req.tripId, driverId } }) : null
        if (!t) return { reject: ['FORBIDDEN', 'El viaje no está asignado a usted o fue reasignado.'] }
        switch (req.type) {
          case 'checklist': {
            if (!['ASIGNADO', 'LISTO_PARA_SALIDA'].includes(t.lifecycle)) return { reject: ['RESOURCE_CONFLICT', `El viaje está «${TRIP_LIFECYCLE.label(t.lifecycle)}»: el checklist ya no aplica.`] }
            const items = req.payload.checklist ?? []
            const failed = items.filter((x) => !x.ok)
            const criticalFailed = failed.filter((x) => CHECKLIST.find((c) => c.id === x.itemId)?.critical)
            await tx.tripEvent.create({ data: { tenantId: t.tenantId, tripId: t.id, actor: p.name, kind: 'EJECUCION', at: occurredAt, summary: failed.length ? `Checklist con ${failed.length} ítem(s) fallido(s)${criticalFailed.length ? ` (${criticalFailed.length} crítico/s)` : ''}` : 'Checklist completado sin observaciones' } })
            await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'driver.checklist', after: failed.length ? `Con fallas: ${failed.map((f) => f.itemId).join(', ')}` : 'OK' }, tx)
            if (failed.length) {
              const pub = await this.notifications.notify({ tenantId: t.tenantId, kind: 'checklist.failed', severity: criticalFailed.length ? 'ALTA' : 'MEDIA', title: 'Checklist con fallas', body: `${t.code}: ${failed.length} ítem(s) fallido(s) reportados por ${p.name}.`, link: `/viajes/${t.id}` }, tx)
              if (pub) effects.push(pub)
            }
            return { status: 'Confirmada', message: failed.length ? 'Se notificó al despachador las fallas reportadas.' : undefined, serverAt: serverAt() }
          }
          case 'start': {
            if (t.lifecycle === 'EN_RUTA') return { status: 'Confirmada', message: 'El viaje ya estaba en ruta.', serverAt: serverAt() }
            // ADR-008: sin despacho autorizado no hay inicio, ni siquiera offline (el servidor rechaza lo que llegue tarde).
            if (t.lifecycle !== 'LISTO_PARA_SALIDA' || !t.dispatchAuthorized) return { reject: ['GATE_NOT_SATISFIED', 'El despacho no está autorizado: no puede iniciar el viaje. Contacte al despachador.'] }
            const g = await this.trips.gateOf(tx, t)
            if (g.overall === 'No habilitado') return { reject: ['GATE_NOT_SATISFIED', 'El viaje ya no cumple la habilitación. Contacte al despachador.'] }
            await this.trips.startEffective(tx, t, p.name)
            await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'driver.start', before: 'Listo para salida', after: 'En ruta' }, tx)
            return { status: 'Confirmada', serverAt: serverAt() }
          }
          case 'incident': {
            const inc = req.payload.incident
            const category = inc ? INCIDENT_CATEGORY.parse(inc.category) : undefined
            if (!inc || !category || clean(inc.description).length < 5) return { reject: ['VALIDATION_ERROR', 'Falta la categoría o el detalle de la incidencia.'] }
            const files = [...new Set(req.payload.evidenceFileIds ?? [])]
            const valid = files.length ? (await tx.storedFile.findMany({ where: { id: { in: files }, status: 'DISPONIBLE' }, select: { id: true } })).map((f) => f.id) : []
            const r = await this.incidents.createIn(
              tx, t.tenantId, { id: p.userId, name: p.name },
              { tripId: t.id, category, severity: inc.emergency ? 'CRITICA' : 'MEDIA', emergency: inc.emergency, description: inc.description, occurredAt, evidenceNames: (req.payload.evidenceNames ?? []).map(clean).filter(Boolean), evidenceFileIds: valid, source: 'conductor' },
              t,
            )
            effects.push(...r.effects)
            return { status: 'Confirmada', message: `Incidencia ${r.inc.code} registrada.`, serverAt: serverAt() }
          }
          case 'arrival': {
            if (t.lifecycle === 'EN_DESTINO') return { status: 'Confirmada', message: 'La llegada ya estaba registrada.', serverAt: serverAt() }
            if (t.lifecycle !== 'EN_RUTA') return { reject: ['RESOURCE_CONFLICT', `El viaje está «${TRIP_LIFECYCLE.label(t.lifecycle)}»: no se puede registrar llegada.`] }
            await this.trips.recordArrival(tx, t, p.name, 'Llegada registrada por el conductor')
            await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'driver.arrival', before: 'En ruta', after: 'En destino' }, tx)
            return { status: 'Confirmada', serverAt: serverAt() }
          }
          case 'finish': {
            if (t.lifecycle !== 'EN_DESTINO') return { reject: ['RESOURCE_CONFLICT', 'Registre primero la llegada.'] }
            await tx.tripEvent.create({ data: { tenantId: t.tenantId, tripId: t.id, actor: p.name, kind: 'EJECUCION', summary: 'Conductor finalizó operación y entregó evidencia' } })
            await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'driver.finish' }, tx)
            return { status: 'Confirmada', message: 'El despachador cerrará el viaje.', serverAt: serverAt() }
          }
          case 'message': {
            const text = clean(req.payload.message?.text)
            if (!text) return { reject: ['VALIDATION_ERROR', 'Falta el texto del mensaje.'] }
            effects.push(await this.messages.fromDriver(tx, p, t, text, occurredAt))
            return { status: 'Confirmada', message: 'Mensaje enviado a control.', serverAt: serverAt() }
          }
        }
      })
      if ('reject' in out) return reject(...out.reject)
      effects.forEach((e) => e())
      return out
    } catch (e) {
      // Un error de negocio también es una respuesta definitiva para el outbox (no se reintenta en bucle).
      if (e instanceof AppError && e.status < 500) return reject(e.code, e.detail ?? e.title)
      throw e
    }
  }
}
