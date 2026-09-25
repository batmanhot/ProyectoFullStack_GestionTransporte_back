import { Injectable } from '@nestjs/common'
import type { Prisma, Route } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { ROUTE_STATUS } from '../../common/labels'
import { pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { parsePoints } from './domain/stops'
import { OPEN_TRIP } from './domain/trip-rules'
import type { RouteDto } from './planning.dto'

/** Radio por defecto de las geocercas de origen y destino (SUPUESTO TÉCNICO: GAP-009 no fija radios). */
const DEFAULT_GEOFENCE_RADIUS_M = 400

export interface Geofence {
  id: string
  name: string
  lat: number
  lon: number
  radiusM: number
}

export const parseGeofences = (json: unknown): Geofence[] =>
  Array.isArray(json)
    ? json.flatMap((g: unknown) => {
        const o = g as Record<string, unknown> | null
        return o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.lat === 'number' && typeof o.lon === 'number' && typeof o.radiusM === 'number'
          ? [{ id: o.id, name: o.name, lat: o.lat, lon: o.lon, radiusM: o.radiusM }]
          : []
      })
    : []

export const routeView = (r: Route) => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  destination: r.destination,
  points: parsePoints(r.points),
  geofences: parseGeofences(r.geofences),
  speedLimitKmh: r.speedLimitKmh,
  distanceKm: r.distanceKm,
  version: r.version,
  status: ROUTE_STATUS.label(r.status),
  baseId: r.baseId,
  authorizedAlternatives: r.authorizedAlternatives,
})

/**
 * Rutas (ENT-010/011 · RF-009 · FE-020). Versionadas: «editar» = nueva versión autorizada; la anterior queda «Obsoleta».
 * Nunca se borran («Retirar» = Obsoleta, con motivo, y solo sin viajes activos).
 */
@Injectable()
export class RoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  scopeWhere(p: Principal): Prisma.RouteWhereInput {
    return new DataScope(p).baseWhere() ?? {}
  }

  async list(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['name', 'origin', 'destination', 'status', 'version', 'distanceKm'], filters: ['status', 'baseId'], defaultSort: { field: 'name', dir: 'asc' } })
    const rows = await this.prisma.db.route.findMany({ where: this.scopeWhere(p), orderBy: [{ name: 'asc' }, { version: 'desc' }] })
    return pageInMemory(rows.map(routeView), q, {
      search: (r) => `${r.name} ${r.origin} ${r.destination}`,
      filters: { status: (r, v) => r.status === v, baseId: (r, v) => r.baseId === v },
      facets: { status: (r) => r.status },
      sort: { name: (r) => r.name, origin: (r) => r.origin, destination: (r) => r.destination, status: (r) => r.status, version: (r) => r.version, distanceKm: (r) => r.distanceKm },
    })
  }

  async create(p: Principal, dto: RouteDto) {
    const errs = new FieldErrors()
    const stops = dto.points.filter((x) => x.stop)
    errs.when(stops.length === 1, 'points', 'Marque al menos dos paradas de pasajeros, o ninguna si el viaje es directo.')
    if (stops.length >= 2) {
      errs.when(stops[0]!.stop === 'Baja' || stops[stops.length - 1]!.stop === 'Sube', 'points', 'La primera parada debe permitir subir y la última permitir bajar.')
      errs.when(new Set(stops.map((x) => x.name.trim().toLowerCase())).size !== stops.length, 'points', 'Los nombres de las paradas no pueden repetirse.')
    }
    errs.throwIfAny()
    if (!new DataScope(p).covers(dto.baseId)) throw Errors.forbidden('La terminal está fuera de su alcance.')
    return this.prisma.tx(async (tx) => {
      if (!(await tx.orgUnit.findFirst({ where: { id: dto.baseId, type: 'BASE', active: true }, select: { id: true } }))) throw Errors.field('baseId', 'La terminal no existe o está inactiva.')
      const name = clean(dto.name)
      const prev = await tx.route.findFirst({ where: { name, status: 'AUTORIZADA' }, orderBy: { version: 'desc' } })
      const lastVersion = await tx.route.findFirst({ where: { name }, orderBy: { version: 'desc' }, select: { version: true } })
      if (prev) await tx.route.update({ where: { id: prev.id }, data: { status: 'OBSOLETA', retiredReason: 'Reemplazada por una nueva versión' } })
      const first = dto.points[0]!
      const last = dto.points[dto.points.length - 1]!
      const points = dto.points.map((x) => ({ name: clean(x.name), lat: x.lat, lon: x.lon, stop: x.stop ?? null }))
      const r = await tx.route.create({
        data: {
          tenantId: p.tenantId as string, name, origin: clean(dto.origin), destination: clean(dto.destination), points, speedLimitKmh: dto.speedLimitKmh, distanceKm: dto.distanceKm,
          version: (lastVersion?.version ?? 0) + 1, status: 'AUTORIZADA', baseId: dto.baseId, authorizedAlternatives: dto.authorizedAlternatives.map(clean).filter(Boolean), createdBy: p.name,
          geofences: [
            { id: `${name}-origen`, name: clean(dto.origin), lat: first.lat, lon: first.lon, radiusM: DEFAULT_GEOFENCE_RADIUS_M },
            { id: `${name}-destino`, name: clean(dto.destination), lat: last.lat, lon: last.lon, radiusM: DEFAULT_GEOFENCE_RADIUS_M },
          ],
        },
      })
      await this.audit.record({ resourceType: 'Ruta', resourceId: r.name, action: prev ? 'route.version' : 'route.create', before: prev ? `v${prev.version}` : null, after: `v${r.version}` }, tx)
      return routeView(r)
    })
  }

  async retire(p: Principal, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const r = await tx.route.findFirst({ where: { id, ...this.scopeWhere(p) } })
      if (!r) throw Errors.unavailable()
      if (r.status !== 'AUTORIZADA') throw Errors.conflict('Estado inválido', `La ruta ya está «${ROUTE_STATUS.label(r.status)}».`)
      const open = await tx.trip.findMany({ where: { routeId: id, lifecycle: { in: OPEN_TRIP } }, select: { code: true } })
      if (open.length) throw Errors.conflict('Ruta en uso', `${open.length} viaje(s) activos usan esta ruta (${open.map((t) => t.code).join(', ')}). Reprográmelos o ciérrelos antes de retirarla.`)
      const next = await tx.route.update({ where: { id }, data: { status: 'OBSOLETA', retiredReason: clean(reason) } })
      await this.audit.record({ resourceType: 'Ruta', resourceId: r.name, action: 'route.retire', reason: clean(reason), before: 'Autorizada', after: 'Obsoleta' }, tx)
      return routeView(next)
    })
  }
}
