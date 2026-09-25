import { Injectable } from '@nestjs/common'
import type { Incident, IncidentAction, IncidentCategory, IncidentStatus, Prisma, Severity, Trip } from '../../generated/prisma/client'
import { Errors } from '../../common/errors/app-error'
import { INCIDENT_CATEGORY, INCIDENT_STATUS, SEVERITY } from '../../common/labels'
import { cutoff, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { NATIVE_APPROVERS, SENIOR_REVIEWERS } from '../access/domain/catalog'
import { hasRole, type Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notifications/notification.service'
import { RealtimePublisher } from '../realtime/realtime.publisher'

type Row = Incident & { actions: IncidentAction[] }
const FLOW: Record<IncidentStatus, IncidentStatus[]> = { NUEVA: ['CLASIFICADA'], CLASIFICADA: ['EN_ATENCION'], EN_ATENCION: ['CONTENIDA', 'RESUELTA'], CONTENIDA: ['RESUELTA'], RESUELTA: ['CERRADA'], CERRADA: [] }

export const incidentView = (i: Row, files: { id: string; name: string; size: number; type: string }[] = []) => ({
  id: i.id,
  code: i.code,
  category: i.category ? INCIDENT_CATEGORY.label(i.category) : null,
  severity: SEVERITY.label(i.severity),
  status: INCIDENT_STATUS.label(i.status),
  emergency: i.emergency,
  originAlertId: i.originAlertId,
  tripId: i.tripId,
  tripCode: i.tripCode,
  vehiclePlate: i.vehiclePlate,
  description: i.description,
  continuityPlan: i.continuityPlan,
  resolution: i.resolution,
  evidenceCount: i.evidenceNames.length + i.evidenceFileIds.length,
  ...(files.length ? { evidenceFiles: files.map((f) => ({ fileId: f.id, name: f.name, size: f.size, type: f.type })) } : {}),
  createdAt: i.createdAt.toISOString(),
  reportedBy: i.reportedBy,
  actions: [...i.actions].sort((a, b) => a.at.getTime() - b.at.getTime()).map((a) => ({ at: a.at.toISOString(), actor: a.actor, text: a.text })),
  requiresReview: i.requiresReview,
  version: i.version,
})

export interface NewIncident {
  tripId: string | null
  category: IncidentCategory | null
  severity: Severity
  emergency: boolean
  description: string
  originAlertId?: string | null
  occurredAt?: Date
  evidenceNames?: string[]
  evidenceFileIds?: string[]
  source?: 'control' | 'conductor'
}

/**
 * Incidencias y emergencias (PROC-007 · RF-021/022 · FE-032). Una incidencia es un CASO que requiere gestión humana (≠ alerta).
 * Registrar y coordinar no sustituye a los sistemas especializados de emergencia (límite de DOC-A §C.7).
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimePublisher,
    private readonly counters: CountersService,
  ) {}

  private async scopeWhere(p: Principal): Promise<Prisma.IncidentWhereInput> {
    const scope = new DataScope(p)
    if (scope.tenantWide) return {}
    const vehicles = await this.prisma.db.vehicle.findMany({ where: scope.baseWhere(true) ?? {}, select: { id: true } })
    return { OR: [{ vehicleId: { in: vehicles.map((v) => v.id) } }, { vehicleId: null }] }
  }

  private async files(tx: Tx, rows: Incident[]) {
    const ids = rows.flatMap((r) => r.evidenceFileIds)
    return ids.length ? tx.storedFile.findMany({ where: { id: { in: ids } } }) : []
  }

  private async view(tx: Tx, id: string) {
    const i = await tx.incident.findFirstOrThrow({ where: { id }, include: { actions: true } })
    return incidentView(i, await this.files(tx, [i]))
  }

  async list(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['createdAt', 'severity', 'status', 'code'], filters: ['status', 'severity', 'emergency', 'open', 'tripId'], defaultSort: { field: 'createdAt', dir: 'desc' } })
    const db = this.prisma.db
    const universe = await this.scopeWhere(p)
    const and: Prisma.IncidentWhereInput[] = [universe]
    const f = q.filters
    if (f.status) {
      const s = INCIDENT_STATUS.parse(f.status)
      if (!s) throw Errors.field('status', 'Estado desconocido.')
      and.push({ status: s })
    }
    if (f.severity) {
      const s = SEVERITY.parse(f.severity)
      if (!s) throw Errors.field('severity', 'Severidad desconocida.')
      and.push({ severity: s })
    }
    if (f.emergency) and.push({ emergency: f.emergency === 'true' })
    if (f.open) and.push(f.open === 'true' ? { status: { not: 'CERRADA' } } : { status: 'CERRADA' })
    if (f.tripId) and.push({ tripId: f.tripId })
    if (q.search) {
      const s = { contains: q.search, mode: 'insensitive' as const }
      and.push({ OR: [{ code: s }, { description: s }, { tripCode: s }, { vehiclePlate: s }] })
    }
    const where = { AND: and }
    const orderBy: Prisma.IncidentOrderByWithRelationInput[] = q.sort ? [{ [q.sort.field]: q.sort.dir }, { id: 'asc' }] : [{ createdAt: 'desc' }]
    const [rows, total, overall, byStatus, bySev, emergencies, open] = await Promise.all([
      db.incident.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { actions: true } }),
      db.incident.count({ where }),
      db.incident.count({ where: universe }),
      db.incident.groupBy({ by: ['status'], where: universe, _count: { _all: true } }),
      db.incident.groupBy({ by: ['severity'], where: universe, _count: { _all: true } }),
      db.incident.count({ where: { AND: [universe, { emergency: true }] } }),
      db.incident.count({ where: { AND: [universe, { status: { not: 'CERRADA' } }] } }),
    ])
    const files = await this.files(db, rows)
    return {
      items: rows.map((r) => incidentView(r, files.filter((x) => r.evidenceFileIds.includes(x.id)))),
      total,
      page: q.page,
      pageSize: q.pageSize,
      cutoffAt: cutoff(),
      overall,
      facets: {
        status: Object.fromEntries(byStatus.map((x) => [INCIDENT_STATUS.label(x.status), x._count._all])),
        severity: Object.fromEntries(bySev.map((x) => [SEVERITY.label(x.severity), x._count._all])),
        emergency: { true: emergencies, false: overall - emergencies },
        open: { true: open, false: overall - open },
      },
    }
  }

  /** Alta de incidencia (control o app del conductor). Devuelve la fila y los efectos a publicar tras el commit. */
  async createIn(tx: Tx, tenantId: string, actor: { id: string; name: string }, i: NewIncident, trip: Trip | null) {
    if (i.originAlertId) {
      const dup = await tx.incident.findFirst({ where: { originAlertId: i.originAlertId, status: { not: 'CERRADA' } }, select: { code: true } })
      if (dup) throw Errors.conflict('Incidencia duplicada', `Ya existe una incidencia abierta para esta alerta (${dup.code}) — EXC-025.`)
      if (!(await tx.alert.findFirst({ where: { id: i.originAlertId }, select: { id: true } }))) throw Errors.field('originAlertId', 'La alerta de origen no existe.')
    }
    const inc = await tx.incident.create({
      data: {
        tenantId, code: await this.counters.next(tx, tenantId, 'incident'), category: i.category, severity: i.severity, status: i.category ? 'CLASIFICADA' : 'NUEVA', emergency: i.emergency,
        originAlertId: i.originAlertId ?? null, tripId: trip?.id ?? null, tripCode: trip?.code ?? null, vehicleId: trip?.vehicleId ?? null, vehiclePlate: trip?.vehiclePlate ?? null,
        description: clean(i.description), reportedBy: actor.name, reportedById: actor.id, requiresReview: i.emergency || i.severity === 'ALTA' || i.severity === 'CRITICA',
        occurredAt: i.occurredAt ?? new Date(), evidenceNames: i.evidenceNames ?? [], evidenceFileIds: i.evidenceFileIds ?? [],
      },
      include: { actions: true },
    })
    if (i.originAlertId) await tx.alert.update({ where: { id: i.originAlertId }, data: { incidentId: inc.id, version: { increment: 1 } } })
    if (trip) await tx.tripEvent.create({ data: { tenantId, tripId: trip.id, actor: actor.name, kind: 'INCIDENCIA', summary: `Incidencia ${inc.code} ${i.source === 'conductor' ? 'reportada por el conductor' : 'abierta'}` } })
    await this.audit.record({ resourceType: 'Incidencia', resourceId: inc.code, action: 'incident.create', after: `${SEVERITY.label(i.severity)}${i.emergency ? ' · EMERGENCIA' : ''}${i.source === 'conductor' ? ' · reportada por conductor (app)' : ''}` }, tx)
    const effects: (() => void)[] = []
    const pub = await this.notifications.notify(
      {
        tenantId,
        kind: i.emergency ? 'incident.emergency' : 'incident.reported',
        severity: i.emergency ? 'CRITICA' : i.severity,
        title: i.emergency ? 'EMERGENCIA declarada' : 'Incidencia registrada',
        body: `${inc.code}${trip ? ` · ${trip.code}` : ''}: ${inc.description.slice(0, 100)}`,
        link: '/monitoreo/incidencias',
      },
      tx,
    )
    if (pub) effects.push(pub)
    if (i.emergency) {
      // PC-A14: el mapa refleja la emergencia al instante, sin esperar el siguiente sondeo.
      const view = incidentView(inc)
      effects.push(() => this.realtime.publish(tenantId, { type: 'incident.emergency', incident: view }, { anyPerm: ['tracking.view', 'incident.manage', 'alert.manage'], baseId: trip?.baseId ?? null }))
    }
    return { inc, effects }
  }

  async create(p: Principal, dto: { tripId: string | null; category: string | null; severity: string; emergency: boolean; description: string; originAlertId?: string | null }) {
    if (clean(dto.description).length < 10) throw Errors.field('description', 'Describa lo ocurrido (mín. 10 caracteres).')
    const severity = SEVERITY.parse(dto.severity)
    if (!severity) throw Errors.field('severity', 'Severidad inválida.')
    const category = dto.category ? INCIDENT_CATEGORY.parse(dto.category) : null
    if (dto.category && !category) throw Errors.field('category', 'Categoría inválida.')
    const scope = new DataScope(p)
    const effects: (() => void)[] = []
    const id = await this.prisma.tx(async (tx) => {
      const trip = dto.tripId ? await tx.trip.findFirst({ where: { id: dto.tripId } }) : null
      if (dto.tripId && (!trip || !scope.covers(trip.baseId))) throw Errors.field('tripId', 'El viaje no existe o está fuera de su alcance.')
      const r = await this.createIn(tx, p.tenantId as string, { id: p.userId, name: p.name }, { tripId: trip?.id ?? null, category: category ?? null, severity, emergency: dto.emergency, description: dto.description, originAlertId: dto.originAlertId ?? null, source: 'control' }, trip)
      effects.push(...r.effects)
      return r.inc.id
    })
    effects.forEach((e) => e())
    return this.view(this.prisma.db, id)
  }

  async addAction(p: Principal, id: string, text: string) {
    if (!clean(text)) throw Errors.field('text', 'Escriba la acción realizada.')
    return this.prisma.tx(async (tx) => {
      const inc = await tx.incident.findFirst({ where: { AND: [{ id }, await this.scopeWhere(p)] } })
      if (!inc) throw Errors.unavailable()
      if (inc.status === 'CERRADA') throw Errors.conflict('Incidencia cerrada', 'Una incidencia cerrada no admite nuevas acciones; su historial se conserva.')
      await tx.incidentAction.create({ data: { tenantId: inc.tenantId, incidentId: inc.id, actor: p.name, text: clean(text) } })
      await tx.incident.update({ where: { id }, data: { version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Incidencia', resourceId: inc.code, action: 'incident.action', after: clean(text).slice(0, 200) }, tx)
      return this.view(tx, id)
    })
  }

  async advance(p: Principal, id: string, dto: { to: string; category?: string; resolution?: string; continuityPlan?: string; evidenceNames?: string[]; evidenceFileIds?: string[] }) {
    const to = INCIDENT_STATUS.parse(dto.to)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    return this.prisma.tx(async (tx) => {
      const inc = await tx.incident.findFirst({ where: { AND: [{ id }, await this.scopeWhere(p)] } })
      if (!inc) throw Errors.unavailable()
      if (!FLOW[inc.status].includes(to)) throw Errors.conflict('Transición inválida', `No se puede pasar de «${INCIDENT_STATUS.label(inc.status)}» a «${dto.to}».`)
      const fileIds = [...new Set(dto.evidenceFileIds ?? [])]
      if (fileIds.length && (await tx.storedFile.count({ where: { id: { in: fileIds }, status: 'DISPONIBLE' } })) !== fileIds.length) throw Errors.field('evidence', 'Una evidencia no existe o expiró: vuelva a subirla.')
      const names = (dto.evidenceNames ?? []).map(clean).filter(Boolean)
      const incoming = fileIds.length + names.length
      const category = dto.category ? INCIDENT_CATEGORY.parse(dto.category) : undefined
      if (dto.category && !category) throw Errors.field('category', 'Categoría inválida.')
      if (to === 'CLASIFICADA' && !(category ?? inc.category)) throw Errors.field('category', 'Seleccione la categoría.')
      if (to === 'RESUELTA' && !clean(dto.resolution)) throw Errors.field('resolution', 'Indique la resolución.')
      if (to === 'CERRADA') {
        // CTRL-021: cierre con resolución o evidencia. Severidad alta/crítica: revisión de ROL-010/ROL-003 (o administrador del negocio, PC-A1).
        if (!inc.resolution && inc.evidenceNames.length + inc.evidenceFileIds.length + incoming === 0) throw Errors.field('resolution', 'El cierre requiere resolución o evidencia (CTRL-021).')
        if (inc.requiresReview && !hasRole(p, ...SENIOR_REVIEWERS, ...NATIVE_APPROVERS)) {
          await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Incidencia', resourceId: inc.code, action: 'access.denied', result: 'DENEGADO', after: 'Cierre con revisión requerida' })
          throw Errors.forbidden('El cierre de incidencias de severidad alta/crítica requiere revisión del Responsable de seguridad, el Jefe de transporte o un Administrador del negocio.', { rule: 'CTRL-021' })
        }
      }
      const now = new Date()
      await tx.incident.update({
        where: { id },
        data: {
          status: to,
          version: { increment: 1 },
          ...(category ? { category } : {}),
          ...(clean(dto.continuityPlan) ? { continuityPlan: clean(dto.continuityPlan) } : {}),
          ...(to === 'RESUELTA' ? { resolution: clean(dto.resolution), resolvedAt: now } : {}),
          ...(to === 'CERRADA' ? { closedAt: now } : {}),
          ...(fileIds.length ? { evidenceFileIds: { push: fileIds } } : {}),
          ...(names.length ? { evidenceNames: { push: names } } : {}),
        },
      })
      await tx.incidentAction.create({ data: { tenantId: inc.tenantId, incidentId: inc.id, actor: p.name, text: `Estado: ${INCIDENT_STATUS.label(inc.status)} → ${dto.to}` } })
      await this.audit.record({ resourceType: 'Incidencia', resourceId: inc.code, action: 'incident.advance', before: INCIDENT_STATUS.label(inc.status), after: dto.to, reason: incoming ? `${incoming} evidencia(s) adjunta(s)` : null }, tx)
      return this.view(tx, id)
    })
  }
}
