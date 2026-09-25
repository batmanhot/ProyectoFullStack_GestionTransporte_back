import { Inject, Injectable } from '@nestjs/common'
import type { Prisma, Trip, TripAssignment, TripEvent } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { PRIORITY, TRIP_EVENT, TRIP_LIFECYCLE } from '../../common/labels'
import { iso } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { tripConditions, type TripCondition } from './domain/trip-rules'

export type TripRow = Trip & { events?: TripEvent[]; assignments?: TripAssignment[] }

interface ConditionIndex {
  alerts: Map<string, { kind: string; severity: string }[]>
  incidents: Map<string, { emergency: boolean }[]>
  now: number
}

/**
 * Lectura de viajes: alcance de visibilidad (POL-002) + condiciones derivadas (DEC-002).
 *  - Conductor (OWN_RECORDS): solo sus viajes.
 *  - Cliente comercial (CUSTOMER_ORG): solo viajes marcados para su organización (GAP-006: cómo se marcan queda pendiente).
 *  - Resto: por terminal (BASE) salvo alcance de todo el negocio.
 */
@Injectable()
export class TripReadModel {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async visibleWhere(p: Principal, client: Tx = this.prisma.db): Promise<Prisma.TripWhereInput> {
    const scope = new DataScope(p)
    if (scope.isDriver) {
      const d = await client.driver.findFirst({ where: { userId: p.userId }, select: { id: true } })
      return { driverId: d?.id ?? '00000000-0000-0000-0000-000000000000' }
    }
    if (scope.isCustomer) return { customerOrgId: { in: [...scope.customerOrgs] } }
    return scope.baseWhere() ?? {}
  }

  async conditionIndex(tripIds: string[], client: Tx = this.prisma.db): Promise<ConditionIndex> {
    if (!tripIds.length) return { alerts: new Map(), incidents: new Map(), now: Date.now() }
    const [alerts, incidents] = await Promise.all([
      client.alert.findMany({ where: { tripId: { in: tripIds }, status: { notIn: ['RESUELTA', 'CERRADA'] } }, select: { tripId: true, kind: true, severity: true } }),
      client.incident.findMany({ where: { tripId: { in: tripIds }, status: { not: 'CERRADA' } }, select: { tripId: true, emergency: true } }),
    ])
    const a = new Map<string, { kind: string; severity: string }[]>()
    for (const x of alerts) if (x.tripId) a.set(x.tripId, [...(a.get(x.tripId) ?? []), { kind: x.kind, severity: x.severity }])
    const i = new Map<string, { emergency: boolean }[]>()
    for (const x of incidents) if (x.tripId) i.set(x.tripId, [...(i.get(x.tripId) ?? []), { emergency: x.emergency }])
    return { alerts: a, incidents: i, now: Date.now() }
  }

  conditionsOf(t: Trip, idx: ConditionIndex): TripCondition[] {
    const al = idx.alerts.get(t.id) ?? []
    const inc = idx.incidents.get(t.id) ?? []
    return tripConditions({
      lifecycle: t.lifecycle,
      plannedEta: t.plannedEta,
      etaUpdated: t.etaUpdated,
      openAlertKinds: al.map((x) => x.kind),
      openAlertSeverities: al.map((x) => x.severity),
      openIncidents: inc.length,
      emergency: inc.some((x) => x.emergency),
      now: idx.now,
      delayToleranceMs: this.config.ops.delayToleranceMinutes * 60_000,
    })
  }

  view(t: TripRow, idx: ConditionIndex) {
    return {
      id: t.id,
      code: t.code,
      routeId: t.routeId,
      routeName: t.routeName,
      routeVersion: t.routeVersion,
      baseId: t.baseId,
      baseName: t.baseName,
      plannedDeparture: t.plannedDeparture.toISOString(),
      plannedEta: t.plannedEta.toISOString(),
      etaUpdated: iso(t.etaUpdated),
      vehicleId: t.vehicleId,
      vehiclePlate: t.vehiclePlate,
      driverId: t.driverId,
      driverName: t.driverName,
      priority: PRIORITY.label(t.priority),
      instructions: t.instructions,
      lifecycle: TRIP_LIFECYCLE.label(t.lifecycle),
      conditions: this.conditionsOf(t, idx),
      createdBy: t.createdBy,
      createdByUserId: t.createdByUserId,
      serviceId: t.serviceId,
      serviceCode: t.serviceCode,
      serviceName: t.serviceName,
      dispatchAuthorized: t.dispatchAuthorized,
      version: t.version,
      events: (t.events ?? []).map((e) => ({ id: e.id, at: e.at.toISOString(), actor: e.actor, kind: TRIP_EVENT.label(e.kind), summary: e.summary, ...(e.reason ? { reason: e.reason } : {}) })),
      assignmentHistory: (t.assignments ?? []).map((a) => ({ at: a.at.toISOString(), vehiclePlate: a.vehiclePlate, driverName: a.driverName, actor: a.actor, ...(a.reason ? { reason: a.reason } : {}) })),
    }
  }

  async views(rows: TripRow[], client: Tx = this.prisma.db) {
    const idx = await this.conditionIndex(rows.map((t) => t.id), client)
    return rows.map((t) => this.view(t, idx))
  }

  async one(id: string, client: Tx = this.prisma.db) {
    const t = await client.trip.findFirst({ where: { id }, include: { events: { orderBy: { at: 'asc' } }, assignments: { orderBy: { at: 'asc' } } } })
    if (!t) return null
    const [v] = await this.views([t], client)
    return v ?? null
  }
}
