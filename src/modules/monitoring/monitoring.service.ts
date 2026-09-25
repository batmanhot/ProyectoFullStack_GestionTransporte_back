import { Inject, Injectable } from '@nestjs/common'
import type { AlertStatus, Prisma } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { Errors } from '../../common/errors/app-error'
import { ALERT_KIND, ALERT_STATUS, SEVERITY } from '../../common/labels'
import { cutoff, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import { NATIVE_APPROVERS, SENIOR_REVIEWERS } from '../access/domain/catalog'
import { hasPerm, hasRole, type Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { FleetReadModel } from '../fleet/fleet.read-model'
import { parsePoints } from '../planning/domain/stops'
import { TripReadModel } from '../planning/trip.read-model'
import { alertView } from './alert.engine'
import { classifyFreshness, routeProgress } from './domain/geo'
import { ARRIVING_PROGRESS } from './telemetry.service'

const OPEN_ALERT: AlertStatus[] = ['NUEVA', 'RECONOCIDA', 'EN_GESTION']
const FLOW: Record<'acknowledge' | 'manage' | 'resolve' | 'close', { from: AlertStatus[]; to: AlertStatus; verb: string }> = {
  acknowledge: { from: ['NUEVA'], to: 'RECONOCIDA', verb: 'reconocer' },
  manage: { from: ['RECONOCIDA'], to: 'EN_GESTION', verb: 'gestionar' },
  resolve: { from: ['RECONOCIDA', 'EN_GESTION'], to: 'RESUELTA', verb: 'resolver' },
  close: { from: ['RESUELTA'], to: 'CERRADA', verb: 'cerrar' },
}
export type AlertAction = keyof typeof FLOW
export const isAlertAction = (x: string): x is AlertAction => x in FLOW

/**
 * Centro de control (PROC-004 · RF-016–020 · FE-030/031). Toda cifra se calcula en el servidor sobre lo que el usuario
 * puede ver (POL-002). La frescura la decide el servidor (RN-005); el FE solo la dibuja.
 */
@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripReadModel,
    private readonly fleet: FleetReadModel,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async positions(p: Principal) {
    const db = this.prisma.db
    const scope = new DataScope(p)
    const tripWhere = await this.trips.visibleWhere(p)
    const [enRoute, vehicles] = await Promise.all([
      db.trip.findMany({ where: { AND: [tripWhere, { lifecycle: { in: ['EN_RUTA', 'LISTO_PARA_SALIDA'] } }] } }),
      scope.isCustomer || scope.isDriver ? Promise.resolve([]) : db.vehicle.findMany({ where: scope.baseWhere(true) ?? {}, select: { id: true } }),
    ])
    const vehicleIds = new Set([...vehicles.map((v) => v.id), ...enRoute.map((t) => t.vehicleId).filter((x): x is string => !!x)])
    const ids = [...vehicleIds]
    const [lastPos, vrows, alerts, emergencies, routes] = await Promise.all([
      db.vehicleLastPosition.findMany({ where: { vehicleId: { in: ids } } }),
      db.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, plate: true, gpsDeviceId: true } }),
      db.alert.findMany({ where: { vehicleId: { in: ids }, status: { in: OPEN_ALERT }, kind: { in: ['EXCESO_VELOCIDAD', 'RETRASO'] } }, select: { vehicleId: true, kind: true } }),
      db.incident.findMany({ where: { vehicleId: { in: ids }, emergency: true, status: { not: 'CERRADA' } }, select: { vehicleId: true } }),
      db.route.findMany({ where: { id: { in: enRoute.map((t) => t.routeId) } } }),
    ])
    const now = Date.now()
    const pos = new Map(lastPos.map((x) => [x.vehicleId, x]))
    const items = vrows
      // Un vehículo sin viaje activo y sin posición no aporta al mapa; uno EN RUTA sin GPS sí (se lista como «No disponible»).
      .filter((v) => pos.has(v.id) || enRoute.some((t) => t.vehicleId === v.id))
      .map((v) => {
        const lp = pos.get(v.id)
        const trip = enRoute.find((t) => t.vehicleId === v.id) ?? null
        const route = trip ? routes.find((r) => r.id === trip.routeId) : undefined
        const { freshness, ageSeconds } = classifyFreshness(lp?.sourceTime ?? null, now, this.config.ops.positionFreshSeconds)
        const pts = route ? parsePoints(route.points) : []
        const progress = lp && pts.length >= 2 ? routeProgress({ lat: lp.lat, lon: lp.lon }, pts) : 0
        return {
          vehicleId: v.id, plate: v.plate, tripId: trip?.id ?? null, tripCode: trip?.code ?? null, driverName: trip?.driverName ?? null,
          lat: lp?.lat ?? null, lon: lp?.lon ?? null, speedKmh: lp?.speedKmh ?? null, heading: lp?.heading ?? null, ignition: lp?.ignition ?? null,
          sourceTime: lp?.sourceTime.toISOString() ?? null, freshness, ageSeconds,
          speeding: alerts.some((a) => a.vehicleId === v.id && a.kind === 'EXCESO_VELOCIDAD'),
          emergency: emergencies.some((i) => i.vehicleId === v.id),
          delayed: alerts.some((a) => a.vehicleId === v.id && a.kind === 'RETRASO'),
          arriving: trip?.lifecycle === 'EN_RUTA' && freshness !== 'No disponible' && progress >= ARRIVING_PROGRESS,
          origin: route?.origin ?? null,
          destination: route?.destination ?? null,
        }
      })
    return { items, cutoffAt: cutoff() }
  }

  async summary(p: Principal) {
    const db = this.prisma.db
    const scope = new DataScope(p)
    const tripWhere = await this.trips.visibleWhere(p)
    const trips = await db.trip.findMany({ where: { AND: [tripWhere, { lifecycle: { in: ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA'] } }] }, orderBy: { plannedDeparture: 'asc' } })
    const idx = await this.trips.conditionIndex(trips.map((t) => t.id))
    const enRoute = trips.filter((t) => t.lifecycle === 'EN_RUTA')
    const fleetVisible = scope.seesFleet && !scope.isCustomer
    const vehicles = fleetVisible ? await this.fleet.vehicleViews(scope.baseWhere(true) ?? {}) : []
    const canAlerts = hasPerm(p, 'alert.manage')
    const alertWhere = canAlerts ? await this.alertScope(p) : null
    const [openAlerts, critical] = alertWhere
      ? await Promise.all([db.alert.count({ where: { AND: [alertWhere, { status: { in: OPEN_ALERT } }] } }), db.alert.count({ where: { AND: [alertWhere, { status: { in: OPEN_ALERT }, severity: { in: ['ALTA', 'CRITICA'] } }] } })])
      : [null, null]
    return {
      cutoffAt: cutoff(),
      enRoute: enRoute.length,
      enRouteDelayed: enRoute.filter((t) => this.trips.conditionsOf(t, idx).includes('Retrasado')).length,
      enRouteWithAlert: enRoute.filter((t) => this.trips.conditionsOf(t, idx).includes('Con alerta')).length,
      readyToDepart: trips.filter((t) => t.lifecycle === 'LISTO_PARA_SALIDA').length,
      awaitingEnable: trips.filter((t) => t.lifecycle === 'ASIGNADO').length,
      // `null` = sin visibilidad de flota (nunca un 0 falso).
      availableAtBase: fleetVisible ? vehicles.filter((v) => v.lifecycle === 'Disponible' && v.eligibility !== 'No habilitado').length : null,
      vehiclesTotal: fleetVisible ? vehicles.length : null,
      openAlerts,
      criticalAlerts: critical,
      nextDepartures: trips
        .filter((t) => t.lifecycle === 'LISTO_PARA_SALIDA' || t.lifecycle === 'ASIGNADO')
        .slice(0, 5)
        .map((t) => ({ tripId: t.id, code: t.code, routeName: t.routeName, vehiclePlate: t.vehiclePlate, driverName: t.driverName, plannedDeparture: t.plannedDeparture.toISOString(), lifecycle: t.lifecycle === 'ASIGNADO' ? 'Asignado' : 'Listo para salida', dispatchAuthorized: t.dispatchAuthorized })),
    }
  }

  /**
   * Alcance de alertas: todo el negocio o, con alcance por terminal/flota, las de sus vehículos (más las que no tienen vehículo,
   * p. ej. vencimiento de documentos de conductor). Quien solo administra documentos ve únicamente «Vencimiento» (PC-A7).
   */
  async alertScope(p: Principal): Promise<Prisma.AlertWhereInput> {
    const scope = new DataScope(p)
    const and: Prisma.AlertWhereInput[] = []
    if (!hasPerm(p, 'alert.manage')) and.push({ kind: 'VENCIMIENTO' })
    if (!scope.tenantWide) {
      const vehicles = await this.prisma.db.vehicle.findMany({ where: scope.baseWhere(true) ?? {}, select: { id: true } })
      and.push({ OR: [{ vehicleId: { in: vehicles.map((v) => v.id) } }, { vehicleId: null }] })
    }
    return { AND: and }
  }

  async listAlerts(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['severity', 'createdAt', 'status', 'kind'], filters: ['status', 'severity', 'kind', 'open', 'hasIncident', 'tripId'], defaultSort: { field: 'severity', dir: 'desc' } })
    const db = this.prisma.db
    const universe = await this.alertScope(p)
    const and: Prisma.AlertWhereInput[] = [universe]
    const f = q.filters
    if (f.status) {
      const st = ALERT_STATUS.parse(f.status)
      if (!st) throw Errors.field('status', 'Estado de alerta desconocido.')
      and.push({ status: st })
    }
    if (f.severity) {
      const s = SEVERITY.parse(f.severity)
      if (!s) throw Errors.field('severity', 'Severidad desconocida.')
      and.push({ severity: s })
    }
    if (f.kind) {
      const k = ALERT_KIND.parse(f.kind)
      if (!k) throw Errors.field('kind', 'Tipo de alerta desconocido.')
      and.push({ kind: k })
    }
    if (f.open === '1') and.push({ status: { in: OPEN_ALERT } })
    if (f.hasIncident) and.push(f.hasIncident === '1' ? { incidentId: { not: null } } : { incidentId: null })
    if (f.tripId) and.push({ tripId: f.tripId })
    if (q.search) {
      const s = { contains: q.search, mode: 'insensitive' as const }
      and.push({ OR: [{ detail: s }, { tripCode: s }, { vehiclePlate: s }, { subject: s }, { assignee: s }] })
    }
    const where = { AND: and }
    // Bandeja de trabajo: orden por severidad y luego por antigüedad (PROPUESTA C.2-2 aceptada: página, no cursor).
    const orderBy: Prisma.AlertOrderByWithRelationInput[] =
      q.sort?.field === 'severity' ? [{ severity: q.sort.dir }, { createdAt: 'desc' }] : q.sort ? [{ [q.sort.field]: q.sort.dir }, { id: 'asc' }] : [{ createdAt: 'desc' }]
    const openUniverse = { AND: [universe, { status: { in: OPEN_ALERT } }] }
    const [rows, total, overall, bySev, byStatus, byKind, withInc, openCount] = await Promise.all([
      db.alert.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.alert.count({ where }),
      db.alert.count({ where: universe }),
      db.alert.groupBy({ by: ['severity'], where: openUniverse, _count: { _all: true } }),
      db.alert.groupBy({ by: ['status'], where: openUniverse, _count: { _all: true } }),
      db.alert.groupBy({ by: ['kind'], where: openUniverse, _count: { _all: true } }),
      db.alert.count({ where: { AND: [openUniverse, { incidentId: { not: null } }] } }),
      db.alert.count({ where: openUniverse }),
    ])
    const fileIds = rows.flatMap((a) => a.evidenceFileIds)
    const files = fileIds.length ? await db.storedFile.findMany({ where: { id: { in: fileIds } } }) : []
    return {
      items: rows.map((a) => alertView(a, files.filter((f) => a.evidenceFileIds.includes(f.id)))),
      total,
      page: q.page,
      pageSize: q.pageSize,
      cutoffAt: cutoff(),
      overall,
      // Las facetas de la bandeja cuentan solo alertas ABIERTAS (DOC-D-FE §I.1).
      facets: {
        open: { '1': openCount, '0': overall - openCount },
        severity: Object.fromEntries(bySev.map((x) => [SEVERITY.label(x.severity), x._count._all])),
        status: Object.fromEntries(byStatus.map((x) => [ALERT_STATUS.label(x.status), x._count._all])),
        kind: Object.fromEntries(byKind.map((x) => [ALERT_KIND.label(x.kind), x._count._all])),
        hasIncident: { '1': withInc, '0': openCount - withInc },
      },
    }
  }

  async alertAction(p: Principal, id: string, action: AlertAction, input: { reason?: string; evidence?: string; evidenceFileIds?: string[] }) {
    const rule = FLOW[action]
    return this.prisma.tx(async (tx) => {
      const a = await tx.alert.findFirst({ where: { AND: [{ id }, await this.alertScope(p)] } })
      if (!a) throw Errors.unavailable()
      if (!rule.from.includes(a.status)) throw Errors.conflict('Estado inválido', `La alerta está «${ALERT_STATUS.label(a.status)}»: no se puede ${rule.verb}.`)
      const reason = clean(input.reason) || clean(input.evidence)
      if (action === 'resolve' && reason.length < 3) throw Errors.field('reason', 'Indique la resolución o evidencia.')
      const fileIds = action === 'resolve' ? [...new Set(input.evidenceFileIds ?? [])] : []
      if (fileIds.length) {
        const n = await tx.storedFile.count({ where: { id: { in: fileIds }, status: 'DISPONIBLE' } })
        if (n !== fileIds.length) throw Errors.field('evidence', 'Una evidencia no existe o expiró: vuelva a subirla.')
      }
      // Cierre de alerta Alta/Crítica: revisión del Responsable de seguridad, Jefe de transporte o Administrador del negocio (PC-A1 Fase 3).
      if (action === 'close' && a.requiresReview && !hasRole(p, ...SENIOR_REVIEWERS, ...NATIVE_APPROVERS)) {
        await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Alerta', resourceId: a.id, action: 'access.denied', result: 'DENEGADO', after: 'Cierre con revisión requerida' })
        throw Errors.forbidden('El cierre de una alerta Alta/Crítica requiere revisión del Responsable de seguridad, el Jefe de transporte o un Administrador del negocio.', { rule: 'CTRL-013' })
      }
      const now = new Date()
      const next = await tx.alert.update({
        where: { id },
        data: {
          status: rule.to,
          version: { increment: 1 },
          ...(action === 'acknowledge' ? { ackAt: now, assignee: p.name } : {}),
          ...(action === 'manage' ? { assignee: p.name } : {}),
          ...(action === 'resolve' ? { resolvedAt: now, evidence: reason, evidenceFileIds: fileIds } : {}),
          ...(action === 'close' ? { closedAt: now } : {}),
        },
      })
      await this.audit.record({ resourceType: 'Alerta', resourceId: a.id, action: `alert.${action}`, before: ALERT_STATUS.label(a.status), after: ALERT_STATUS.label(rule.to), reason: reason || null }, tx)
      const files = fileIds.length ? await tx.storedFile.findMany({ where: { id: { in: fileIds } } }) : []
      return alertView(next, files)
    })
  }
}
