import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { AuditEvent, Prisma } from '../../generated/prisma/client'
import { Errors } from '../../common/errors/app-error'
import { Cursor, cutoff } from '../../common/http/list-query'
import { clean } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import type { Permission } from '../access/domain/catalog'
import { hasPerm, type Principal } from '../access/domain/principal'
import { AuditService } from './audit.service'

const MAX_PAGE = 100

/** Facetas de la auditoría (DOC-D-FE §I.1): denegaciones, exportaciones, excepciones. */
const FLAG_WHERE: Record<string, Prisma.AuditEventWhereInput> = {
  denegado: { result: 'DENEGADO' },
  exportacion: { action: 'report.export' },
  excepcion: { action: { in: ['sod.exception', 'support.open'] } },
}

/**
 * POL-004 / CTRL-026: qué permiso de LECTURA exige exportar cada recurso y si es sensible. La sensibilidad la decide el
 * SERVIDOR (no la bandera del cliente): identidad de personas, auditoría y manifiestos son siempre sensibles.
 */
const EXPORTS: { match: (r: string) => boolean; anyOf: Permission[]; sensitive: boolean }[] = [
  { match: (r) => r === 'Vehículos', anyOf: ['vehicle.manage', 'resource.eligibility.view', 'trip.create'], sensitive: false },
  { match: (r) => r === 'Conductores', anyOf: ['driver.manage', 'resource.eligibility.view', 'trip.create'], sensitive: true },
  { match: (r) => r === 'Documentos', anyOf: ['document.manage', 'resource.eligibility.view', 'vehicle.manage'], sensitive: false },
  { match: (r) => r === 'Mantenimiento', anyOf: ['maintenance.manage', 'vehicle.manage', 'resource.eligibility.view'], sensitive: false },
  { match: (r) => r === 'Rutas', anyOf: ['route.manage', 'trip.create', 'trip.assign', 'tracking.view'], sensitive: false },
  { match: (r) => r === 'Viajes', anyOf: ['trip.create', 'trip.assign', 'trip.enable', 'trip.dispatch', 'tracking.view', 'trip.cancel'], sensitive: false },
  { match: (r) => r === 'Servicios', anyOf: ['service.manage', 'trip.create'], sensitive: false },
  { match: (r) => r === 'Alertas', anyOf: ['alert.manage'], sensitive: false },
  { match: (r) => r === 'Incidencias', anyOf: ['incident.manage'], sensitive: false },
  { match: (r) => r === 'Carga', anyOf: ['cargo.manage'], sensitive: false },
  { match: (r) => r === 'Pasajeros' || r.startsWith('Manifiesto'), anyOf: ['passenger.manage'], sensitive: true },
  { match: (r) => r === 'Usuarios', anyOf: ['tenant.user.manage'], sensitive: true },
  { match: (r) => r === 'Auditoría' || r === 'Auditoría global', anyOf: ['audit.view'], sensitive: true },
  { match: (r) => r === 'Negocios', anyOf: ['platform.tenant.manage'], sensitive: false },
]

const entryView = (a: AuditEvent, redact: boolean) => ({
  id: a.id,
  at: a.at.toISOString(),
  kind: a.kind === 'SEGURIDAD' ? 'Seguridad' : 'Negocio',
  actor: a.actor,
  tenantId: a.tenantId,
  resourceType: a.resourceType,
  resourceId: redact && a.tenantId ? '—' : a.resourceId,
  action: a.action,
  // EXC-032: la plataforma ve METADATOS de eventos de un negocio, nunca su contenido.
  ...(redact && a.tenantId ? {} : { ...(a.reason ? { reason: a.reason } : {}), ...(a.before ? { before: a.before } : {}), ...(a.after ? { after: a.after } : {}) }),
  correlationId: a.correlationId,
})

/** Consulta de auditoría (RF-029/031 · FE-050/073), exportación autorizada y línea de tiempo por registro. */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: { cursor?: string; pageSize?: string; search?: string; kind?: string; flag?: string }) {
    const size = q.pageSize ? Number(q.pageSize) : 15
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw Errors.field('pageSize', `pageSize debe estar entre 1 y ${MAX_PAGE}.`)
    const platform = p.kind === 'platform'
    // Plataforma: cliente de sistema (lee todos los negocios) pero con contenido redactado. Negocio: cliente aislado.
    const client = platform ? this.prisma.system : this.prisma.db
    const universe: Prisma.AuditEventWhereInput = {}
    const and: Prisma.AuditEventWhereInput[] = [universe]
    if (q.kind) and.push({ kind: q.kind === 'Seguridad' ? 'SEGURIDAD' : 'NEGOCIO' })
    if (q.flag) {
      const f = FLAG_WHERE[q.flag]
      if (!f) throw Errors.field('flag', 'Filtro desconocido.')
      and.push(f)
    }
    const search = clean(q.search)
    if (search) {
      const s = { contains: search, mode: 'insensitive' as const }
      and.push({ OR: [{ actor: s }, { resourceType: s }, { action: s }, ...(platform ? [] : [{ resourceId: s }])] })
    }
    const c = Cursor.decode(q.cursor)
    if (c) and.push({ OR: [{ at: { lt: c.at } }, { at: c.at, id: { lt: c.id } }] })
    const where = { AND: and }
    const [rows, overall, byKind, denied, exports, exceptions] = await Promise.all([
      client.auditEvent.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: size + 1 }),
      client.auditEvent.count({ where: universe }),
      client.auditEvent.groupBy({ by: ['kind'], where: universe, _count: { _all: true } }),
      client.auditEvent.count({ where: FLAG_WHERE.denegado! }),
      client.auditEvent.count({ where: FLAG_WHERE.exportacion! }),
      client.auditEvent.count({ where: FLAG_WHERE.excepcion! }),
    ])
    const page = rows.slice(0, size)
    const last = page[page.length - 1]
    return {
      items: page.map((a) => entryView(a, platform)),
      nextCursor: rows.length > size && last ? Cursor.encode(last.at, last.id) : null,
      totalApprox: null,
      cutoffAt: cutoff(),
      overall,
      facets: {
        kind: Object.fromEntries(byKind.map((x) => [x.kind === 'SEGURIDAD' ? 'Seguridad' : 'Negocio', x._count._all])),
        flag: { denegado: denied, exportacion: exports, excepcion: exceptions },
      },
    }
  }

  /** Autoriza y audita la exportación ANTES de que el cliente genere el archivo (POL-004 · CTRL-026). */
  async registerExport(p: Principal, i: { resource: string; format: 'xlsx' | 'pdf'; filters: Record<string, string>; rowCount: number; sensitive: boolean }) {
    const rule = EXPORTS.find((e) => e.match(i.resource))
    if (!rule) throw Errors.field('resource', 'Recurso no exportable.')
    if (!hasPerm(p, ...rule.anyOf)) {
      await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Exportación', resourceId: i.resource, action: 'access.denied', result: 'DENEGADO', after: 'Exportación sin permiso de lectura del recurso' })
      throw Errors.forbidden('No tiene permiso para consultar este recurso: no puede exportarlo (POL-004).')
    }
    const sensitive = rule.sensitive || i.sensitive
    const filters = Object.entries(i.filters).slice(0, 20).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join('; ')
    const exportId = randomUUID()
    await this.audit.record({
      kind: sensitive ? 'Seguridad' : 'Negocio', resourceType: 'Exportación', resourceId: i.resource, action: 'report.export',
      after: `${i.format.toUpperCase()} · ${i.rowCount} filas${sensitive ? ' · datos sensibles' : ''}${filters ? ` · ${filters}` : ''} · id ${exportId}`,
    })
    return { exportId, authorizedAt: new Date().toISOString() }
  }

  /** Seguimiento de UN registro (PC-A1 Fase 3), más antiguo primero. */
  async timeline(p: Principal, resourceType: string, resourceId: string) {
    if (!resourceType || !resourceId) throw Errors.field('resourceId', 'Indique el registro.')
    const client = p.kind === 'platform' ? this.prisma.system : this.prisma.db
    const rows = await client.auditEvent.findMany({ where: { resourceType, resourceId }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: 500 })
    return rows.map((a) => entryView(a, p.kind === 'platform'))
  }
}
