import { Injectable } from '@nestjs/common'
import type { ServiceStatus, TransportService } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { SERVICE_STATUS } from '../../common/labels'
import { pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, parseDate } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { clientDocumentProblem, MastersService, normalizeDoc } from '../masters/masters.service'
import { OPEN_TRIP } from './domain/trip-rules'
import type { ServiceDto } from './planning.dto'

const FLOW: Record<ServiceStatus, ServiceStatus[]> = { BORRADOR: ['VIGENTE'], VIGENTE: ['SUSPENDIDO', 'FINALIZADO'], SUSPENDIDO: ['VIGENTE', 'FINALIZADO'], FINALIZADO: [] }
/** La vigencia incluye todo el último día. */
const endOfDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T23:59:59.999Z`).getTime()
const d10 = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Servicio de transporte (ENT-009 · RF-008 · PC-A8 — definición PROPUESTA por el FE, GAP-002 abierto).
 * Borrador → Vigente ⇄ Suspendido → Finalizado. En un servicio vigente solo se cambian notas, se AMPLÍA la vigencia y se SUMAN rutas.
 */
@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly masters: MastersService,
    private readonly counters: CountersService,
  ) {}

  private async view(tx: Tx, s: TransportService, now = Date.now()) {
    const [routes, trips] = await Promise.all([
      tx.route.findMany({ where: { id: { in: s.routeIds } }, select: { id: true, name: true } }),
      tx.trip.findMany({ where: { serviceId: s.id }, select: { lifecycle: true } }),
    ])
    return {
      id: s.id, code: s.code, name: s.name, documentType: s.documentType, document: s.document, customer: s.customer, type: s.type,
      routeIds: s.routeIds, routeNames: s.routeIds.map((id) => routes.find((r) => r.id === id)?.name ?? id),
      startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), status: SERVICE_STATUS.label(s.status), notes: s.notes,
      tripsTotal: trips.length, tripsOpen: trips.filter((t) => OPEN_TRIP.includes(t.lifecycle)).length,
      expired: s.status === 'VIGENTE' && endOfDay(s.endsAt) < now, lastChangeReason: s.lastChangeReason, createdBy: s.createdBy, version: s.version,
    }
  }

  async list(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['code', 'name', 'customer', 'endsAt', 'status'], filters: ['status', 'type', 'expiring'], defaultSort: { field: 'code', dir: 'asc' } })
    const db = this.prisma.db
    const rows = await db.transportService.findMany()
    const items = await Promise.all(rows.map((s) => this.view(db, s)))
    const expiring = (s: (typeof items)[number]) => s.status === 'Vigente' && !s.expired && endOfDay(new Date(s.endsAt)) - Date.now() <= 30 * 86_400_000
    return pageInMemory(items, q, {
      search: (s) => `${s.code} ${s.name} ${s.customer} ${s.type} ${s.routeNames.join(' ')}`,
      filters: { status: (s, v) => s.status === v, type: (s, v) => s.type === v, expiring: (s, v) => (v === 'true') === expiring(s) },
      facets: { status: (s) => s.status, type: (s) => s.type, expiring: (s) => String(expiring(s)) },
      sort: { code: (s) => s.code, name: (s) => s.name, customer: (s) => s.customer, endsAt: (s) => s.endsAt, status: (s) => s.status },
    })
  }

  private async validate(tx: Tx, dto: ServiceDto) {
    const errs = new FieldErrors()
    if (!(await this.masters.isActiveLabel(tx, 'SERVICE_TYPE', dto.type))) errs.add('type', 'Seleccione un tipo de servicio válido.')
    if (dto.documentType) {
      const problem = clean(dto.document) ? clientDocumentProblem(dto.documentType, dto.document) : 'Indique el documento del cliente.'
      if (problem) errs.add('document', problem)
    }
    const starts = parseDate(dto.startsAt)
    const ends = parseDate(dto.endsAt)
    if (!starts || !ends) errs.add('endsAt', 'Indique la vigencia (inicio y término).')
    else if (ends <= starts) errs.add('endsAt', 'El término debe ser posterior al inicio.')
    if (!dto.routeIds.length) errs.add('routeIds', 'Seleccione al menos una ruta autorizada.')
    else {
      const ok = await tx.route.count({ where: { id: { in: dto.routeIds }, status: 'AUTORIZADA' } })
      if (ok !== new Set(dto.routeIds).size) errs.add('routeIds', 'Solo se pueden asociar rutas autorizadas de su empresa.')
    }
    errs.throwIfAny()
    return { starts: starts!, ends: ends! }
  }

  async create(p: Principal, dto: ServiceDto) {
    return this.prisma.tx(async (tx) => {
      const { starts, ends } = await this.validate(tx, dto)
      const tenantId = p.tenantId as string
      const documentType = dto.documentType ?? null
      const document = documentType && dto.document ? normalizeDoc(dto.document) : null
      const s = await tx.transportService.create({
        data: {
          tenantId, code: await this.counters.next(tx, tenantId, 'service'), name: clean(dto.name), documentType, document, customer: clean(dto.customer), type: clean(dto.type),
          routeIds: [...new Set(dto.routeIds)], startsAt: starts, endsAt: ends, notes: clean(dto.notes), createdBy: p.name,
        },
      })
      if (documentType && document) await this.masters.upsertClient(tx, tenantId, documentType, document, s.customer)
      await this.audit.record({ resourceType: 'Servicio', resourceId: s.code, action: 'service.create', after: `${s.name} · ${s.customer}` }, tx)
      return this.view(tx, s)
    })
  }

  async update(p: Principal, id: string, dto: ServiceDto) {
    return this.prisma.tx(async (tx) => {
      const s = await tx.transportService.findFirst({ where: { id } })
      if (!s) throw Errors.unavailable()
      if (s.status === 'SUSPENDIDO' || s.status === 'FINALIZADO') {
        throw Errors.conflict('Servicio no editable', `Un servicio «${SERVICE_STATUS.label(s.status)}» no se edita${s.status === 'SUSPENDIDO' ? ': reanúdelo primero' : '; el historial se conserva'}.`)
      }
      const { starts, ends } = await this.validate(tx, dto)
      // `documentType` ausente = no se tocó; null explícito = se quitó a propósito (p. ej. «Público general»).
      const documentType = dto.documentType === undefined ? s.documentType : dto.documentType
      const document = documentType && dto.document ? normalizeDoc(dto.document) : dto.documentType === undefined ? s.document : null
      if (s.status === 'VIGENTE') {
        const errs = new FieldErrors()
        errs.when(clean(dto.name) !== s.name || clean(dto.customer) !== s.customer || clean(dto.type) !== s.type || documentType !== s.documentType || document !== s.document, 'name', 'En un servicio vigente solo se cambian las notas, se amplía la vigencia y se suman rutas.')
        errs.when(d10(starts) !== d10(s.startsAt), 'startsAt', 'El inicio de un servicio vigente no se modifica.')
        errs.when(d10(ends) < d10(s.endsAt), 'endsAt', 'La vigencia solo se puede ampliar, no acortar.')
        errs.when(s.routeIds.some((r) => !dto.routeIds.includes(r)), 'routeIds', 'No se pueden quitar rutas de un servicio vigente (hay viajes que las usan).')
        errs.throwIfAny()
      }
      const next = await tx.transportService.update({
        where: { id },
        data: { name: clean(dto.name), documentType, document, customer: clean(dto.customer), type: clean(dto.type), routeIds: [...new Set(dto.routeIds)], startsAt: starts, endsAt: ends, notes: clean(dto.notes), version: { increment: 1 } },
      })
      if (documentType && document) await this.masters.upsertClient(tx, p.tenantId as string, documentType, document, next.customer)
      await this.audit.record({ resourceType: 'Servicio', resourceId: s.code, action: 'service.update', before: `${s.name} · hasta ${d10(s.endsAt)}`, after: `${next.name} · hasta ${d10(next.endsAt)}` }, tx)
      return this.view(tx, next)
    })
  }

  async transition(id: string, toLabel: string, reasonRaw?: string) {
    const to = SERVICE_STATUS.parse(toLabel)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    return this.prisma.tx(async (tx) => {
      const s = await tx.transportService.findFirst({ where: { id } })
      if (!s) throw Errors.unavailable()
      if (!FLOW[s.status].includes(to)) throw Errors.conflict('Transición inválida', `No se puede pasar de «${SERVICE_STATUS.label(s.status)}» a «${toLabel}».`)
      const reason = clean(reasonRaw)
      if ((to === 'SUSPENDIDO' || to === 'FINALIZADO') && reason.length < 5) throw Errors.field('reason', 'Indique el motivo (mín. 5 caracteres).')
      if (to === 'VIGENTE') {
        if (endOfDay(s.endsAt) < Date.now()) throw Errors.conflict('Vigencia terminada', 'La vigencia del servicio ya terminó: amplíe la fecha de término antes de activarlo.')
        const ok = await tx.route.count({ where: { id: { in: s.routeIds }, status: 'AUTORIZADA' } })
        if (ok !== s.routeIds.length) throw Errors.conflict('Rutas no autorizadas', 'El servicio incluye rutas que ya no están autorizadas: corrija las rutas antes de activarlo.')
      }
      if (to === 'FINALIZADO') {
        const open = await tx.trip.findMany({ where: { serviceId: s.id, lifecycle: { in: OPEN_TRIP } }, select: { code: true } })
        if (open.length) throw Errors.conflict('Servicio con viajes activos', `${open.length} viaje(s) siguen abiertos (${open.map((t) => t.code).join(', ')}). Ciérrelos o cancélelos antes de finalizar el servicio.`)
      }
      const action = { BORRADOR: 'service.create', VIGENTE: s.status === 'SUSPENDIDO' ? 'service.resume' : 'service.activate', SUSPENDIDO: 'service.suspend', FINALIZADO: 'service.finish' }[to]
      const next = await tx.transportService.update({ where: { id }, data: { status: to, lastChangeReason: reason || null, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Servicio', resourceId: s.code, action, before: SERVICE_STATUS.label(s.status), after: toLabel, reason: reason || null }, tx)
      return this.view(tx, next)
    })
  }
}
