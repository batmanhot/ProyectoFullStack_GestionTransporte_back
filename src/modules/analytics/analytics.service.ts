import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { Errors } from '../../common/errors/app-error'
import { ALERT_KIND, CARGO_STATUS, SEVERITY, SEVERITY_RANK, TRIP_LIFECYCLE } from '../../common/labels'
import { cutoff } from '../../common/http/list-query'
import { MS_DAY } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import { hasPerm, type Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { documentPhase } from '../fleet/domain/eligibility'
import { FleetReadModel } from '../fleet/fleet.read-model'
import { incidentView } from '../incidents/incidents.service'
import { alertView } from '../monitoring/alert.engine'
import { MonitoringService } from '../monitoring/monitoring.service'
import { PassengersService } from '../passengers/passengers.service'
import { TripReadModel } from '../planning/trip.read-model'

type KpiId = 'KPI-001' | 'KPI-002' | 'KPI-003' | 'KPI-004' | 'KPI-005' | 'KPI-006' | 'KPI-007' | 'KPI-008' | 'KPI-009' | 'KPI-010' | 'KPI-011'
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null)
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const dayKey = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`
const OPEN_ALERT = ['NUEVA', 'RECONOCIDA', 'EN_GESTION'] as const

/**
 * KPIs (DOC-A §G) y panel (FE-002). Reglas: fórmulas EXACTAS de DOC-A; solo registros con datos suficientes; `target` nulo
 * (todas las metas están [META PENDIENTE]: no se inventan); período, alcance y momento de corte declarados (NFR-006);
 * la ausencia de GPS no cuenta como velocidad cero. Las tendencias son series REALES por día, nunca ilustrativas.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripReadModel,
    private readonly fleet: FleetReadModel,
    private readonly monitoring: MonitoringService,
    private readonly passengers: PassengersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private days(period: string): number {
    if (period !== '7d' && period !== '30d') throw Errors.field('period', 'Período inválido (7d | 30d).')
    return period === '7d' ? 7 : 30
  }

  async kpis(p: Principal, period: string, baseId?: string) {
    const days = this.days(period)
    const db = this.prisma.db
    const now = Date.now()
    const since = new Date(now - days * MS_DAY)
    const scope = new DataScope(p)
    if (baseId && !scope.covers(baseId)) throw Errors.forbidden('La terminal está fuera de su alcance.')
    const tripWhere: Prisma.TripWhereInput = { AND: [await this.trips.visibleWhere(p), ...(baseId ? [{ baseId }] : [])] }
    const [closed, dispatchedEvents, gateEvals, alerts, incidents, vehicles] = await Promise.all([
      db.trip.findMany({ where: { AND: [tripWhere, { lifecycle: 'CERRADO', closedAt: { gte: since } }] }, select: { id: true, closedAt: true, closedOnTime: true, events: { select: { kind: true } } } }),
      db.tripEvent.findMany({ where: { kind: 'DESPACHO', at: { gte: since }, trip: tripWhere }, select: { tripId: true, at: true } }),
      db.gateEvaluation.findMany({ where: { evaluatedAt: { gte: since } }, select: { tripId: true, failed: true, action: true, evaluatedAt: true } }),
      db.alert.findMany({ where: { AND: [await this.monitoring.alertScope(p), { createdAt: { gte: since } }] }, select: { kind: true, createdAt: true, ackAt: true, tripId: true } }),
      db.incident.findMany({ where: { resolvedAt: { gte: since } }, select: { createdAt: true, resolvedAt: true } }),
      this.fleet.vehicleViews({ AND: [scope.baseWhere(true) ?? {}, ...(baseId ? [{ baseId }] : [])] }),
    ])
    const tripIds = new Set((await db.trip.findMany({ where: tripWhere, select: { id: true } })).map((t) => t.id))
    const evals = gateEvals.filter((g) => tripIds.has(g.tripId))
    const tracked = await db.trip.findMany({ where: { AND: [tripWhere, { startedAt: { gte: since } }] }, select: { vehicleId: true } })
    const gpsVehicles = new Set((await db.vehicle.findMany({ where: { gpsDeviceId: { not: null } }, select: { id: true } })).map((v) => v.id))
    const trackedCount = tracked.filter((t) => t.vehicleId && gpsVehicles.has(t.vehicleId)).length

    // Series diarias reales (últimos min(días, 14)).
    const n = Math.min(days, 14)
    const buckets = Array.from({ length: n }, (_, i) => {
      const end = new Date(now - (n - 1 - i) * MS_DAY)
      return { label: dayKey(end), from: new Date(end.getTime() - MS_DAY), to: end }
    })
    const series = (f: (from: Date, to: Date) => number | null) => buckets.flatMap((b) => {
      const v = f(b.from, b.to)
      return v === null ? [] : [{ label: b.label, value: Math.round(v * 10) / 10 }]
    })
    const inRange = (d: Date | null, a: Date, b: Date) => !!d && d > a && d <= b
    const traceable = (t: (typeof closed)[number]) => ['PLAN', 'DESPACHO', 'EJECUCION', 'CIERRE'].every((k) => t.events.some((e) => e.kind === k))
    const ack = alerts.filter((a) => a.ackAt).map((a) => ({ at: a.createdAt, min: (a.ackAt!.getTime() - a.createdAt.getTime()) / 60000 }))
    const res = incidents.filter((i) => i.resolvedAt).map((i) => ({ at: i.resolvedAt!, min: (i.resolvedAt!.getTime() - i.createdAt.getTime()) / 60000 }))
    const dispatchedIds = [...new Set(dispatchedEvents.map((e) => e.tripId))]
    const passingDispatch = new Set(evals.filter((g) => g.action === 'dispatch' && !g.failed).map((g) => g.tripId))
    const evaluatedTrips = new Set(evals.map((g) => g.tripId))
    const failedTrips = new Set(evals.filter((g) => g.failed).map((g) => g.tripId))

    // Fase 2: ocupación (pico por viaje / asientos) y entregas conformes.
    const paxTrips = await db.trip.findMany({ where: { AND: [tripWhere, { lifecycle: { in: ['LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO', 'CERRADO'] }, plannedDeparture: { gte: since } }] } })
    const occupancy = (await Promise.all(paxTrips.map((t) => this.passengers.tripOption(db, t)))).filter((o): o is NonNullable<typeof o> => !!o)
    const seats = occupancy.reduce((s, o) => s + o.capacity, 0)
    const occupied = occupancy.reduce((s, o) => s + o.peak, 0)
    const [delivered, withException] = await Promise.all([
      db.cargoShipment.findMany({ where: { status: 'ENTREGADA', deliveredAt: { gte: since } }, select: { hadException: true } }),
      db.cargoShipment.count({ where: { status: 'CON_EXCEPCION' } }),
    ])

    const cutoffAt = cutoff()
    const periodLabel = `Últimos ${days} días`
    const LOWER: KpiId[] = ['KPI-004', 'KPI-006', 'KPI-007', 'KPI-008', 'KPI-009']
    const mk = (id: KpiId, name: string, formula: string, process: string, unit: '%' | 'min' | 'n' | 'ratio', value: number | null, trend: { label: string; value: number }[], drillTo: string | null, frequency: string, phase: 'MVP' | 'Fase 2' = 'MVP') => ({
      id, name, formula, process, unit, value, sufficientData: value !== null, trend: value === null ? [] : trend, target: null, frequency, cutoffAt, period: periodLabel, drillTo, phase, polarity: LOWER.includes(id) ? 'lower' : 'higher',
    })
    const ratio = (num: number, den: number) => (den ? Math.round((num / den) * 100) / 100 : null)
    return [
      mk('KPI-001', 'Trazabilidad completa de viaje', 'viajes con plan, despacho, ejecución y cierre trazables / viajes cerrados', 'PROC-003', '%', pct(closed.filter(traceable).length, closed.length),
        series((a, b) => pct(closed.filter((t) => inRange(t.closedAt, a, b) && traceable(t)).length, closed.filter((t) => inRange(t.closedAt, a, b)).length)), '/viajes', 'Diaria'),
      mk('KPI-002', 'Disponibilidad de flota', 'vehículos disponibles y habilitados / vehículos aplicables', 'PROC-002/008', '%', pct(vehicles.filter((v) => v.eligibility !== 'No habilitado' && v.lifecycle !== 'Registrado').length, vehicles.length), [], '/recursos/vehiculos', 'Diaria'),
      mk('KPI-003', 'Cumplimiento de habilitación', 'viajes despachados con CTRL-001 conforme / viajes despachados', 'PROC-003', '%', pct(dispatchedIds.filter((id) => passingDispatch.has(id)).length, dispatchedIds.length),
        series((a, b) => { const ids = [...new Set(dispatchedEvents.filter((e) => inRange(e.at, a, b)).map((e) => e.tripId))]; return pct(ids.filter((id) => passingDispatch.has(id)).length, ids.length) }), '/viajes', 'Diaria'),
      mk('KPI-004', 'Incumplimiento crítico', 'viajes con fallo crítico detectado / viajes evaluados', 'PROC-003/008', '%', pct(failedTrips.size, evaluatedTrips.size),
        series((a, b) => { const e = evals.filter((g) => inRange(g.evaluatedAt, a, b)); return pct(new Set(e.filter((g) => g.failed).map((g) => g.tripId)).size, new Set(e.map((g) => g.tripId)).size) }), '/viajes', 'Diaria'),
      mk('KPI-005', 'Puntualidad de llegada', 'viajes cerrados dentro de tolerancia autorizada / viajes cerrados', 'PROC-003', '%', pct(closed.filter((t) => t.closedOnTime).length, closed.length),
        series((a, b) => { const c = closed.filter((t) => inRange(t.closedAt, a, b)); return pct(c.filter((t) => t.closedOnTime).length, c.length) }), '/viajes', 'Diaria'),
      mk('KPI-006', 'Tiempo a reconocer alerta', 'mediana desde creación a reconocimiento', 'PROC-004', 'min', median(ack.map((x) => x.min)) === null ? null : Math.round(median(ack.map((x) => x.min))!),
        series((a, b) => median(ack.filter((x) => inRange(x.at, a, b)).map((x) => x.min))), '/monitoreo/alertas', 'Continua'),
      mk('KPI-007', 'Tiempo a resolver incidencia', 'mediana desde apertura a resolución', 'PROC-007', 'min', median(res.map((x) => x.min)) === null ? null : Math.round(median(res.map((x) => x.min))!),
        series((a, b) => median(res.filter((x) => inRange(x.at, a, b)).map((x) => x.min))), '/monitoreo/incidencias', 'Continua'),
      mk('KPI-008', 'Excesos de velocidad', 'eventos de exceso / viajes medidos (con GPS)', 'PROC-004', 'ratio', ratio(alerts.filter((a) => a.kind === 'EXCESO_VELOCIDAD').length, trackedCount), [], '/monitoreo/alertas', 'Diaria'),
      mk('KPI-009', 'Desvíos de ruta', 'eventos de desvío / viajes con tracking', 'PROC-004', 'ratio', ratio(alerts.filter((a) => a.kind === 'DESVIO_RUTA').length, trackedCount), [], '/monitoreo/alertas', 'Diaria'),
      mk('KPI-010', 'Ocupación de pasajeros', 'ocupación máxima de asientos por viaje / asientos de los viajes de pasajeros', 'PROC-006', '%', pct(occupied, seats), [], '/pasajeros', 'Por viaje', 'Fase 2'),
      mk('KPI-011', 'Entregas conformes', 'entregas sin excepción / (entregas + cargas con excepción vigente)', 'PROC-005', '%', pct(delivered.filter((d) => !d.hadException).length, delivered.length + withException), [], '/carga', 'Por entrega', 'Fase 2'),
    ]
  }

  async overview(p: Principal, period: string) {
    const days = this.days(period)
    const db = this.prisma.db
    const now = Date.now()
    const scope = new DataScope(p)
    const tripWhere = await this.trips.visibleWhere(p)
    const alertWhere = await this.monitoring.alertScope(p)
    const vehicleWhere = scope.baseWhere(true) ?? {}
    const [byLife, vehicles, openAlerts, openInc, pendingAlerts, pendingInc, events, docs, drivers, recent] = await Promise.all([
      db.trip.groupBy({ by: ['lifecycle'], where: tripWhere, _count: { _all: true } }),
      this.fleet.vehicleViews(vehicleWhere),
      db.alert.findMany({ where: { AND: [alertWhere, { status: { in: [...OPEN_ALERT] } }] }, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }] }),
      db.incident.findMany({ where: { status: { not: 'CERRADA' } }, include: { actions: true }, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }] }),
      db.alert.count({ where: { AND: [alertWhere, { status: 'RESUELTA', requiresReview: true }] } }),
      db.incident.count({ where: { status: 'RESUELTA', requiresReview: true } }),
      db.tripEvent.findMany({ where: { kind: { in: ['PLAN', 'CIERRE'] }, at: { gte: new Date(now - days * MS_DAY) }, trip: tripWhere }, select: { kind: true, at: true } }),
      db.complianceDocument.findMany({ where: { replaced: false } }),
      db.driver.findMany({ where: scope.baseWhere() ?? {}, select: { id: true } }),
      db.trip.findMany({ where: { AND: [tripWhere, { lifecycle: { in: ['EN_RUTA', 'LISTO_PARA_SALIDA', 'EN_DESTINO', 'ASIGNADO', 'PLANIFICADO'] } }] }, orderBy: { plannedDeparture: 'asc' }, take: 40 }),
    ])
    const count = (l: string) => byLife.find((x) => x.lifecycle === l)?._count._all ?? 0
    const visibleRes = new Set([...vehicles.map((v) => v.id), ...drivers.map((d) => d.id)])
    const live = docs.filter((d) => visibleRes.has(d.resourceId))
    const left = (d: { expiresAt: Date }) => (d.expiresAt.getTime() - now) / MS_DAY
    const bucket = (lo: number, hi: number) => live.filter((d) => left(d) >= lo && left(d) < hi).length
    const perDay = Array.from({ length: days }, (_, i) => {
      const d = new Date(now - (days - 1 - i) * MS_DAY)
      return { label: dayKey(d), created: 0, closed: 0 }
    })
    for (const e of events) {
      const b = perDay.find((x) => x.label === dayKey(e.at))
      if (b) b[e.kind === 'PLAN' ? 'created' : 'closed']++
    }
    const rank = ['EN_RUTA', 'LISTO_PARA_SALIDA', 'EN_DESTINO', 'ASIGNADO', 'PLANIFICADO']
    const recentSorted = [...recent].sort((a, b) => rank.indexOf(a.lifecycle) - rank.indexOf(b.lifecycle) || a.plannedDeparture.getTime() - b.plannedDeparture.getTime()).slice(0, 6)
    const idx = await this.trips.conditionIndex(recentSorted.map((t) => t.id))
    const incidentsVisible = openInc.filter((i) => scope.tenantWide || !i.vehicleId || vehicles.some((v) => v.id === i.vehicleId))
    const kinds = [...new Set(openAlerts.map((a) => a.kind))]
    const canCargo = hasPerm(p, 'cargo.manage')
    const canPax = hasPerm(p, 'passenger.manage')
    const phase2 = canCargo || canPax ? await this.phase2(canCargo, canPax, now) : undefined
    return {
      cutoffAt: cutoff(),
      periodDays: days,
      tiles: {
        tripsEnRoute: count('EN_RUTA'),
        tripsReady: count('LISTO_PARA_SALIDA'),
        tripsPlanned: count('PLANIFICADO') + count('ASIGNADO'),
        openAlerts: openAlerts.length,
        criticalAlerts: openAlerts.filter((a) => a.severity === 'ALTA' || a.severity === 'CRITICA').length,
        openIncidents: incidentsVisible.length,
        emergencies: incidentsVisible.filter((i) => i.emergency).length,
        vehiclesTotal: vehicles.length,
        vehiclesNotEligible: vehicles.filter((v) => v.eligibility === 'No habilitado').length,
        docsExpired: live.filter((d) => documentPhase(d, now, this.config.ops.docExpiringDays) === 'Vencido').length,
        docsExpiring: live.filter((d) => documentPhase(d, now, this.config.ops.docExpiringDays) === 'Por vencer').length,
        pendingApprovals: pendingAlerts + pendingInc,
      },
      tripPipeline: ['PLANIFICADO', 'ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO', 'CERRADO'].map((l) => ({ stage: TRIP_LIFECYCLE.label(l as 'PLANIFICADO'), count: count(l) })),
      tripsOutsideFlow: count('CANCELADO') + count('INTERRUMPIDO') + count('REPROGRAMADO'),
      tripsPerDay: perDay,
      alertsBySeverity: (['CRITICA', 'ALTA', 'MEDIA', 'BAJA', 'INFORMATIVA'] as const).map((s) => ({ severity: SEVERITY.label(s), count: openAlerts.filter((a) => a.severity === s).length })),
      alertsByKind: kinds.map((k) => ({ kind: ALERT_KIND.label(k), count: openAlerts.filter((a) => a.kind === k).length })).sort((a, b) => b.count - a.count),
      fleetEligibility: (['Elegible', 'Condicionado', 'No habilitado'] as const).map((label) => ({ label, count: vehicles.filter((v) => v.eligibility === label).length })),
      docExpiry: [
        { bucket: 'Vencidos', count: bucket(-1e9, 0), tone: 'danger' as const },
        { bucket: '≤ 7 días', count: bucket(0, 7), tone: 'warn' as const },
        { bucket: '8–30 días', count: bucket(7, 30), tone: 'info' as const },
        { bucket: '31–90 días', count: bucket(30, 90), tone: 'neutral' as const },
      ],
      recentTrips: recentSorted.map((t) => ({
        id: t.id, code: t.code, routeName: t.routeName, baseName: t.baseName, vehiclePlate: t.vehiclePlate, driverName: t.driverName, lifecycle: TRIP_LIFECYCLE.label(t.lifecycle),
        conditions: this.trips.conditionsOf(t, idx), plannedEta: t.plannedEta.toISOString(), etaUpdated: t.etaUpdated?.toISOString() ?? null, dispatchAuthorized: t.dispatchAuthorized,
      })),
      activeAlerts: openAlerts.slice(0, 5).map((a) => alertView(a)),
      openIncidentList: [...incidentsVisible].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 4).map((i) => incidentView(i)),
      ...(phase2 ? { phase2 } : {}),
    }
  }

  private async phase2(canCargo: boolean, canPax: boolean, now: number) {
    const db = this.prisma.db
    const out: Record<string, unknown> = {}
    if (canCargo) {
      const [byStatus, overdue, inTransit, withException] = await Promise.all([
        db.cargoShipment.groupBy({ by: ['status'], _count: { _all: true } }),
        db.cargoShipment.count({ where: { promisedAt: { lt: new Date(now) }, status: { notIn: ['ENTREGADA', 'CANCELADA'] } } }),
        db.cargoShipment.aggregate({ where: { status: 'EN_TRANSITO' }, _sum: { weightKg: true } }),
        db.cargoShipment.count({ where: { status: 'CON_EXCEPCION' } }),
      ])
      out.cargo = {
        byStatus: (['REGISTRADA', 'ASIGNADA', 'EN_TRANSITO', 'CON_EXCEPCION', 'ENTREGADA', 'CANCELADA'] as const).map((s) => ({ status: CARGO_STATUS.label(s), count: byStatus.find((x) => x.status === s)?._count._all ?? 0 })),
        overdue, inTransitKg: inTransit._sum.weightKg ?? 0, withException,
      }
    }
    if (canPax) {
      const trips = await db.trip.findMany({ where: { lifecycle: { in: ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA'] } }, orderBy: { code: 'asc' } })
      const opts = (await Promise.all(trips.map((t) => this.passengers.tripOption(db, t)))).filter((o): o is NonNullable<typeof o> => !!o && o.booked > 0).slice(0, 6)
      const [onBoard, noShow, reducedMobility] = await Promise.all([
        db.passengerBooking.count({ where: { status: 'ABORDO' } }),
        db.passengerBooking.count({ where: { status: 'NO_SE_PRESENTO' } }),
        db.passengerBooking.count({ where: { reducedMobility: true, status: { in: ['RESERVADA', 'ABORDO'] } } }),
      ])
      out.passengers = {
        trips: opts.map((o) => ({ id: o.id, code: o.code, routeName: o.routeName, lifecycle: o.lifecycle, vehiclePlate: o.vehiclePlate, capacity: o.capacity, peak: o.peak, booked: o.booked })),
        onBoard, noShow, reducedMobility,
      }
    }
    return out
  }
}
