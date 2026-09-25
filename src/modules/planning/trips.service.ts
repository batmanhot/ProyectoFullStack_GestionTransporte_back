import { Inject, Injectable } from '@nestjs/common'
import type { Prisma, Trip, TripEventKind, TripLifecycle } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { Errors } from '../../common/errors/app-error'
import { PRIORITY, TRIP_LIFECYCLE } from '../../common/labels'
import { cutoff, parseListQuery, type Page, type RawQuery } from '../../common/http/list-query'
import { clean, parseDate } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { NATIVE_APPROVERS, type Permission } from '../access/domain/catalog'
import { hasPerm, hasRole, type Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { FleetReadModel } from '../fleet/fleet.read-model'
import { NotificationService } from '../notifications/notification.service'
import { RealtimePublisher } from '../realtime/realtime.publisher'
import { evaluateGate, type GateResult } from './domain/gate'
import { parsePoints, peakOccupancy, routeStops } from './domain/stops'
import { RESOURCE_HOLDING, TRIP_ACTION_RULES, type TripAction } from './domain/trip-rules'
import type { AssignTripDto, TripActionDto, TripDto } from './planning.dto'
import { TripReadModel } from './trip.read-model'

export type Effect = () => void
const SORTS: Record<string, keyof Trip> = { code: 'code', plannedDeparture: 'plannedDeparture', plannedEta: 'plannedEta', lifecycle: 'lifecycle', priority: 'priority', routeName: 'routeName', vehiclePlate: 'vehiclePlate' }
const endOfDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T23:59:59.999Z`)
const startOfDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`)

/**
 * Planificación, habilitación y despacho (PROC-003 · RF-010–014 · FE-021/022).
 * Autorización: PERMISO (guard/aquí por acción) + ALCANCE (terminal) + POLÍTICA (gate CTRL-001, SOD-001, POL-001/003, estado).
 * Concurrencia: versión optimista del viaje + bloqueo de filas de vehículo/conductor al asignar (RN-002 sin carreras).
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly read: TripReadModel,
    private readonly fleet: FleetReadModel,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimePublisher,
    private readonly counters: CountersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /* ─────────────── lectura ─────────────── */

  private async conditionTripIds(kind: string): Promise<Prisma.TripWhereInput> {
    const db = this.prisma.db
    const alertIds = async (where: Prisma.AlertWhereInput) =>
      (await db.alert.findMany({ where: { ...where, tripId: { not: null }, status: { notIn: ['RESUELTA', 'CERRADA'] } }, select: { tripId: true } })).map((a) => a.tripId as string)
    switch (kind) {
      case 'Con alerta':
        return { id: { in: await alertIds({}) } }
      case 'Con incidencia':
        return { id: { in: (await db.incident.findMany({ where: { tripId: { not: null }, status: { not: 'CERRADA' } }, select: { tripId: true } })).map((i) => i.tripId as string) } }
      case 'Sin señal':
        return { id: { in: await alertIds({ kind: 'SIN_SENAL' }) } }
      case 'En riesgo': {
        const em = (await db.incident.findMany({ where: { emergency: true, tripId: { not: null }, status: { not: 'CERRADA' } }, select: { tripId: true } })).map((i) => i.tripId as string)
        return { id: { in: [...(await alertIds({ severity: { in: ['ALTA', 'CRITICA'] } })), ...em] } }
      }
      case 'Retrasado': {
        const limit = new Date(Date.now() - this.config.ops.delayToleranceMinutes * 60_000)
        return { OR: [{ id: { in: await alertIds({ kind: 'RETRASO' }) } }, { lifecycle: 'EN_RUTA', OR: [{ etaUpdated: null, plannedEta: { lt: limit } }, { etaUpdated: { lt: limit } }] }] }
      }
      default:
        throw Errors.field('condition', 'Condición desconocida.')
    }
  }

  async list(p: Principal, raw: RawQuery): Promise<Page<ReturnType<TripReadModel['view']>>> {
    const q = parseListQuery(raw, { sortable: Object.keys(SORTS), filters: ['lifecycle', 'baseId', 'priority', 'condition', 'service', 'vehicleId', 'driverId'], defaultSort: { field: 'plannedDeparture', dir: 'desc' } })
    const db = this.prisma.db
    const universe = await this.read.visibleWhere(p)
    const and: Prisma.TripWhereInput[] = [universe]
    const f = q.filters
    if (f.lifecycle) {
      const l = TRIP_LIFECYCLE.parse(f.lifecycle)
      if (!l) throw Errors.field('lifecycle', 'Estado desconocido.')
      and.push({ lifecycle: l })
    }
    if (f.priority) {
      const pr = PRIORITY.parse(f.priority)
      if (!pr) throw Errors.field('priority', 'Prioridad desconocida.')
      and.push({ priority: pr })
    }
    if (f.baseId) and.push({ baseId: f.baseId })
    if (f.vehicleId) and.push({ vehicleId: f.vehicleId })
    if (f.driverId) and.push({ driverId: f.driverId })
    if (f.service) and.push(f.service === 'Sin servicio' ? { serviceCode: null } : { serviceCode: f.service })
    if (f.condition) and.push(await this.conditionTripIds(f.condition))
    if (q.search) {
      const s = { contains: q.search, mode: 'insensitive' as const }
      and.push({ OR: [{ code: s }, { routeName: s }, { vehiclePlate: s }, { driverName: s }, { serviceCode: s }, { serviceName: s }] })
    }
    const where: Prisma.TripWhereInput = { AND: and }
    const orderBy = q.sort ? [{ [SORTS[q.sort.field] as string]: q.sort.dir }, { id: 'asc' as const }] : [{ plannedDeparture: 'desc' as const }]
    const [rows, total, overall, byLife, byPriority, byService, conditionFacet] = await Promise.all([
      db.trip.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { events: { orderBy: { at: 'asc' } }, assignments: { orderBy: { at: 'asc' } } } }),
      db.trip.count({ where }),
      db.trip.count({ where: universe }),
      db.trip.groupBy({ by: ['lifecycle'], where: universe, _count: { _all: true } }),
      db.trip.groupBy({ by: ['priority'], where: universe, _count: { _all: true } }),
      db.trip.groupBy({ by: ['serviceCode'], where: universe, _count: { _all: true } }),
      this.conditionFacet(universe),
    ])
    return {
      items: await this.read.views(rows),
      total,
      page: q.page,
      pageSize: q.pageSize,
      cutoffAt: cutoff(),
      overall,
      facets: {
        lifecycle: Object.fromEntries(byLife.map((x) => [TRIP_LIFECYCLE.label(x.lifecycle), x._count._all])),
        priority: Object.fromEntries(byPriority.map((x) => [PRIORITY.label(x.priority), x._count._all])),
        service: Object.fromEntries(byService.map((x) => [x.serviceCode ?? 'Sin servicio', x._count._all])),
        condition: conditionFacet,
      },
    }
  }

  private async conditionFacet(universe: Prisma.TripWhereInput): Promise<Record<string, number>> {
    const kinds = ['Retrasado', 'Con alerta', 'Con incidencia', 'Sin señal', 'En riesgo']
    const counts = await Promise.all(kinds.map(async (k) => this.prisma.db.trip.count({ where: { AND: [universe, await this.conditionTripIds(k)] } })))
    return Object.fromEntries(kinds.map((k, i) => [k, counts[i] ?? 0]).filter(([, n]) => (n as number) > 0))
  }

  async get(p: Principal, id: string) {
    const t = await this.prisma.db.trip.findFirst({ where: { AND: [{ id }, await this.read.visibleWhere(p)] }, select: { id: true } })
    if (!t) throw Errors.unavailable('El viaje no existe o está fuera de su alcance.')
    return this.read.one(id)
  }

  /* ─────────────── gate CTRL-001 ─────────────── */

  async gateOf(tx: Tx, t: Trip): Promise<GateResult> {
    const [vehicle, driver, route, cargo, bookings] = await Promise.all([
      t.vehicleId ? tx.vehicle.findFirst({ where: { id: t.vehicleId } }) : null,
      t.driverId ? tx.driver.findFirst({ where: { id: t.driverId } }) : null,
      tx.route.findFirst({ where: { id: t.routeId } }),
      tx.cargoShipment.findMany({ where: { tripId: t.id, status: { in: ['ASIGNADA', 'EN_TRANSITO', 'CON_EXCEPCION'] } }, select: { weightKg: true } }),
      tx.passengerBooking.findMany({ where: { tripId: t.id }, select: { id: true, seat: true, status: true, boardStop: true, alightStop: true } }),
    ])
    const b = vehicle ? await this.fleet.bundle(tx, [vehicle.id]) : null
    const stops = route ? routeStops(parsePoints(route.points)) : []
    return evaluateGate({
      tripId: t.id,
      vehicle: vehicle && b
        ? { plate: vehicle.plate, gpsDeviceId: vehicle.gpsDeviceId, capacityKg: vehicle.capacityKg, capacityPassengers: vehicle.capacityPassengers, blocked: vehicle.blocked, blockReason: vehicle.blockReason, outOfService: vehicle.outOfService, hasOpenIncident: b.incidentVehicles.has(vehicle.id), docs: b.docsByResource.get(vehicle.id) ?? [], maintenance: b.maintByVehicle.get(vehicle.id) ?? [] }
        : null,
      driver: driver ? { name: driver.name, licenseExpiry: driver.licenseExpiry, restrictions: driver.restrictions, trainingPending: driver.trainingPending, aptitudePending: driver.aptitudePending, inactive: driver.inactive } : null,
      route: route ? { name: route.name, version: route.version, status: route.status } : null,
      cargoKg: cargo.length ? cargo.reduce((s, x) => s + x.weightKg, 0) : null,
      passengerPeak: bookings.length ? peakOccupancy(stops, bookings) : null,
      now: Date.now(),
      expiringDays: this.config.ops.docExpiringDays,
    })
  }

  async gate(p: Principal, id: string): Promise<GateResult> {
    const t = await this.prisma.db.trip.findFirst({ where: { AND: [{ id }, await this.read.visibleWhere(p)] } })
    if (!t) throw Errors.unavailable('El viaje no existe o está fuera de su alcance.')
    return this.gateOf(this.prisma.db, t)
  }

  /* ─────────────── escritura ─────────────── */

  private ev(tx: Tx, t: { id: string; tenantId: string }, actor: string, kind: TripEventKind, summary: string, reason?: string | null) {
    return tx.tripEvent.create({ data: { tenantId: t.tenantId, tripId: t.id, actor, kind, summary, reason: reason ?? null } })
  }

  /** Bloquea las filas del vehículo/conductor hasta el fin de la transacción: dos asignaciones simultáneas se serializan (RN-002). */
  private async lockResources(tx: Tx, vehicleId: string | null, driverId: string | null) {
    if (vehicleId) await tx.$queryRaw`SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE`
    if (driverId) await tx.$queryRaw`SELECT "id" FROM "driver" WHERE "id" = ${driverId}::uuid FOR UPDATE`
  }

  /** RN-002 (sin superposición) + EXC-005 (recurso no elegible). */
  private async checkResources(tx: Tx, dep: Date, eta: Date, vehicleId: string | null, driverId: string | null, excludeTripId?: string) {
    await this.lockResources(tx, vehicleId, driverId)
    const clash = await tx.trip.findMany({
      where: {
        id: excludeTripId ? { not: excludeTripId } : undefined,
        lifecycle: { in: RESOURCE_HOLDING },
        plannedDeparture: { lt: eta },
        plannedEta: { gt: dep },
        OR: [...(vehicleId ? [{ vehicleId }] : []), ...(driverId ? [{ driverId }] : [])],
      },
      select: { code: true, vehicleId: true, driverId: true },
    })
    const msgs: string[] = []
    const vc = vehicleId ? clash.find((t) => t.vehicleId === vehicleId) : undefined
    const dc = driverId ? clash.find((t) => t.driverId === driverId) : undefined
    if (vc) msgs.push(`El vehículo ya está asignado al viaje ${vc.code} en esa ventana (RN-002).`)
    if (dc) msgs.push(`El conductor ya está asignado al viaje ${dc.code} en esa ventana (RN-002).`)
    if (msgs.length) throw Errors.conflict('Conflicto de asignación', msgs.join(' '), { rule: 'RN-002' })
    if (vehicleId) {
      const v = await this.fleet.vehicleView(vehicleId, tx)
      if (!v) throw Errors.field('vehicleId', 'Vehículo inexistente.')
      if (v.eligibility === 'No habilitado') throw Errors.conflict('Recurso no elegible', `${v.plate} no es elegible: ${v.eligibilityReasons.join(' · ')} (EXC-005).`)
    }
    if (driverId) {
      const d = await this.fleet.driverView(driverId, tx)
      if (!d) throw Errors.field('driverId', 'Conductor inexistente.')
      if (d.eligibility === 'No habilitado') throw Errors.conflict('Recurso no elegible', `${d.name} no es elegible: ${d.eligibilityReasons.join(' · ')} (EXC-005).`)
    }
  }

  private async validateService(tx: Tx, serviceId: string, routeId: string, routeName: string, dep: Date) {
    const svc = await tx.transportService.findFirst({ where: { id: serviceId } })
    const why = !svc
      ? 'El servicio no existe.'
      : svc.status !== 'VIGENTE'
        ? `El servicio ${svc.code} no está vigente: solo un servicio vigente admite viajes.`
        : !svc.routeIds.includes(routeId)
          ? `La ruta «${routeName}» no está autorizada en el servicio ${svc.code}.`
          : dep < startOfDay(svc.startsAt) || dep > endOfDay(svc.endsAt)
            ? `La salida está fuera de la vigencia del servicio ${svc.code}.`
            : null
    if (why || !svc) throw Errors.field('serviceId', why ?? 'El servicio no existe.')
    return svc
  }

  async create(p: Principal, dto: TripDto) {
    const dep = parseDate(dto.plannedDeparture)
    const eta = parseDate(dto.plannedEta)
    if (!dep || !eta) throw Errors.field('plannedDeparture', 'Fechas inválidas.')
    if (eta <= dep) throw Errors.field('plannedEta', 'El ETA debe ser posterior a la salida.')
    const scope = new DataScope(p)
    const effects: Effect[] = []
    const id = await this.prisma.tx(async (tx) => {
      const r = await tx.route.findFirst({ where: { id: dto.routeId } })
      if (!r) throw Errors.field('routeId', 'Ruta inexistente.')
      if (r.status !== 'AUTORIZADA') throw Errors.field('routeId', 'La ruta seleccionada no está autorizada.')
      if (!scope.covers(r.baseId)) throw Errors.forbidden('La ruta pertenece a una terminal fuera de su alcance.')
      const svc = dto.serviceId ? await this.validateService(tx, dto.serviceId, r.id, r.name, dep) : null
      const vehicleId = dto.vehicleId ?? null
      const driverId = dto.driverId ?? null
      if (vehicleId || driverId) await this.checkResources(tx, dep, eta, vehicleId, driverId)
      const [base, v, d] = await Promise.all([
        tx.orgUnit.findFirst({ where: { id: r.baseId } }),
        vehicleId ? tx.vehicle.findFirst({ where: { id: vehicleId } }) : null,
        driverId ? tx.driver.findFirst({ where: { id: driverId } }) : null,
      ])
      const both = !!v && !!d
      const tenantId = p.tenantId as string
      const t = await tx.trip.create({
        data: {
          tenantId, code: await this.counters.next(tx, tenantId, 'trip'), routeId: r.id, routeName: r.name, routeVersion: r.version, baseId: r.baseId, baseName: base?.name ?? '—',
          plannedDeparture: dep, plannedEta: eta, vehicleId: v?.id ?? null, vehiclePlate: v?.plate ?? null, driverId: d?.id ?? null, driverName: d?.name ?? null,
          priority: PRIORITY.parse(dto.priority)!, instructions: clean(dto.instructions), lifecycle: both ? 'ASIGNADO' : 'PLANIFICADO',
          createdBy: p.name, createdByUserId: p.userId, serviceId: svc?.id ?? null, serviceCode: svc?.code ?? null, serviceName: svc?.name ?? null,
        },
      })
      await this.ev(tx, t, p.name, 'PLAN', 'Viaje creado y planificado')
      if (both) {
        await this.ev(tx, t, p.name, 'ASIGNACION', `Asignado ${v.plate} / ${d.name}`)
        await tx.tripAssignment.create({ data: { tenantId, tripId: t.id, vehiclePlate: v.plate, driverName: d.name, actor: p.name, reason: 'Asignación inicial' } })
      }
      await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'trip.create', after: TRIP_LIFECYCLE.label(t.lifecycle) }, tx)
      effects.push(() => this.realtime.publish(tenantId, { type: 'trip.updated', tripId: t.id }, { baseId: t.baseId }))
      return t.id
    })
    effects.forEach((e) => e())
    return this.read.one(id)
  }

  async assign(p: Principal, id: string, dto: AssignTripDto) {
    const effects: Effect[] = []
    await this.prisma.tx(async (tx) => {
      const t = await this.findVisible(tx, p, id)
      if (t.version !== dto.version) throw Errors.staleVersion('El viaje cambió mientras lo editaba. Recargue para continuar.')
      if (!['PLANIFICADO', 'ASIGNADO'].includes(t.lifecycle)) throw Errors.conflict('Estado inválido', `No se puede asignar un viaje en estado «${TRIP_LIFECYCLE.label(t.lifecycle)}».`)
      await this.checkResources(tx, t.plannedDeparture, t.plannedEta, dto.vehicleId !== t.vehicleId ? dto.vehicleId : null, dto.driverId !== t.driverId ? dto.driverId : null, t.id)
      const [v, d] = await Promise.all([tx.vehicle.findFirst({ where: { id: dto.vehicleId } }), tx.driver.findFirst({ where: { id: dto.driverId } })])
      if (!v || !d) throw Errors.field('vehicleId', 'Vehículo o conductor inexistente.')
      const ok = await tx.trip.updateMany({ where: { id, version: dto.version }, data: { vehicleId: v.id, vehiclePlate: v.plate, driverId: d.id, driverName: d.name, lifecycle: 'ASIGNADO', version: { increment: 1 } } })
      if (ok.count !== 1) throw Errors.staleVersion()
      await tx.tripAssignment.create({ data: { tenantId: t.tenantId, tripId: t.id, vehiclePlate: t.vehiclePlate, driverName: t.driverName, actor: p.name, reason: 'Asignación' } })
      await this.syncBookingsPlate(tx, t.id, v.plate)
      await this.ev(tx, t, p.name, 'ASIGNACION', `Asignado ${v.plate} / ${d.name}`)
      await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: 'trip.assign', before: `${t.vehiclePlate ?? '—'} / ${t.driverName ?? '—'}`, after: `${v.plate} / ${d.name}` }, tx)
      effects.push(() => this.realtime.publish(t.tenantId, { type: 'trip.updated', tripId: t.id }, { baseId: t.baseId, driverUserId: d.userId }))
    })
    effects.forEach((e) => e())
    return this.read.one(id)
  }

  private async findVisible(tx: Tx, p: Principal, id: string) {
    const t = await tx.trip.findFirst({ where: { AND: [{ id }, await this.read.visibleWhere(p, tx)] } })
    if (!t) throw Errors.unavailable('El viaje no existe o está fuera de su alcance.')
    return t
  }

  /** Pasajeros y carga guardan la placa para reportes: se sincroniza si cambia el vehículo. */
  private async syncBookingsPlate(tx: Tx, tripId: string, plate: string) {
    await tx.passengerBooking.updateMany({ where: { tripId }, data: { vehiclePlate: plate } })
    await tx.cargoShipment.updateMany({ where: { tripId, status: { in: ['ASIGNADA', 'EN_TRANSITO', 'CON_EXCEPCION'] } }, data: { vehiclePlate: plate } })
  }

  /** Inicio efectivo (ACT-012 · RF-013): lo registra el despachador (startNow) o el conductor desde su app. */
  async startEffective(tx: Tx, t: Trip, actor: string): Promise<void> {
    await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'EN_RUTA', startedAt: new Date(), version: { increment: 1 } } })
    await this.ev(tx, t, actor, 'EJECUCION', 'Inicio efectivo confirmado')
    if (t.vehicleId) await tx.vehicleLastPosition.updateMany({ where: { vehicleId: t.vehicleId }, data: { tripId: t.id } })
  }

  /** Llegada (RF-013): la usan el despachador y la app del conductor. */
  async recordArrival(tx: Tx, t: Trip, actor: string, summary = 'Llegada registrada'): Promise<void> {
    await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'EN_DESTINO', arrivedAt: new Date(), version: { increment: 1 } } })
    await this.ev(tx, t, actor, 'EJECUCION', summary)
    if (t.vehicleId) await tx.vehicleLastPosition.updateMany({ where: { vehicleId: t.vehicleId, tripId: t.id }, data: { tripId: null } })
  }

  async act(p: Principal, id: string, action: TripAction, dto: TripActionDto) {
    const rule = TRIP_ACTION_RULES[action]
    const effects: Effect[] = []
    let resultId = id
    await this.prisma.tx(async (tx) => {
      const t = await this.findVisible(tx, p, id)
      if (!hasPerm(p, rule.perm as Permission)) {
        await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Viaje', resourceId: t.code, action: 'access.denied', result: 'DENEGADO', after: rule.perm })
        throw Errors.forbidden('Su rol no incluye el permiso requerido para esta acción.')
      }
      if (dto.version !== undefined && dto.version !== t.version) throw Errors.staleVersion('El viaje cambió mientras lo revisaba. Recargue para continuar.')
      if (!rule.from.includes(t.lifecycle)) throw Errors.conflict('Estado inválido', `La acción no aplica a un viaje en estado «${TRIP_LIFECYCLE.label(t.lifecycle)}».`)
      const before = t.lifecycle
      const reason = clean(dto.reason)
      const needReason = (min = 5) => {
        if (reason.length < min) throw Errors.field('reason', `El motivo es obligatorio (mín. ${min} caracteres).`)
      }
      let after: TripLifecycle = t.lifecycle
      const bump = { version: { increment: 1 } }

      switch (action) {
        case 'enable': {
          const g = await this.gateOf(tx, t)
          // Rechazo: la transacción se revierte y la evaluación fallida se registra aparte (persistGateRejection).
          if (g.overall === 'No habilitado') throw new GateRejection(g, 'enable')
          await tx.gateEvaluation.create({ data: { tenantId: t.tenantId, tripId: t.id, overall: g.overall, failed: false, requirements: g.requirements as unknown as Prisma.InputJsonValue, action: 'enable' } })
          await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'LISTO_PARA_SALIDA', ...bump } })
          await this.ev(tx, t, p.name, 'GATE', `Habilitación: ${g.overall}`)
          after = 'LISTO_PARA_SALIDA'
          break
        }
        case 'dispatch': {
          // SOD-001: quien creó el viaje no lo despacha; excepción auditada solo para ROL-003 y administradores del negocio (PC-A1/PC-A3).
          if (t.createdByUserId === p.userId) {
            const canException = hasRole(p, 'ROL-003', ...NATIVE_APPROVERS)
            const exception = clean(dto.sodException)
            if (!(exception.length >= 10 && canException)) {
              await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Viaje', resourceId: t.code, action: 'sod.violation', result: 'DENEGADO', after: 'SOD-001' })
              throw Errors.forbidden(
                'Usted creó este viaje: no puede despacharlo (SOD-001). Otro despachador debe autorizarlo, o el Jefe de transporte/Administrador puede registrar una excepción auditada (mín. 10 caracteres).',
                { rule: 'SOD-001', exceptionAllowed: canException },
              )
            }
            await this.audit.record({ kind: 'Seguridad', resourceType: 'Viaje', resourceId: t.code, action: 'sod.exception', reason: exception, after: 'SOD-001' }, tx)
          }
          // POL-001: el gate se vuelve a evaluar al despachar (los recursos pudieron cambiar desde la habilitación).
          const g = await this.gateOf(tx, t)
          if (g.overall === 'No habilitado') throw new GateRejection(g, 'dispatch', 'El estado de los recursos cambió desde la habilitación. Corrija los requisitos críticos antes de despachar.')
          await tx.gateEvaluation.create({ data: { tenantId: t.tenantId, tripId: t.id, overall: g.overall, failed: false, requirements: g.requirements as unknown as Prisma.InputJsonValue, action: 'dispatch' } })
          await tx.trip.update({ where: { id: t.id }, data: { dispatchAuthorized: true, ...bump } })
          await this.ev(tx, t, p.name, 'DESPACHO', 'Despacho autorizado (POL-001); pendiente de inicio efectivo')
          if (dto.startNow) {
            await this.startEffective(tx, t, p.name)
            after = 'EN_RUTA'
          }
          const pub = await this.notifications.notify({ tenantId: t.tenantId, kind: 'trip.dispatched', severity: 'INFORMATIVA', title: 'Viaje despachado', body: `${t.code} fue autorizado para salir.`, link: `/viajes/${t.id}` }, tx)
          if (pub) effects.push(pub)
          break
        }
        case 'arrival':
          await this.recordArrival(tx, t, p.name)
          after = 'EN_DESTINO'
          break
        case 'close': {
          // DOC-A PROC-003: «completar manifiestos, entrega/desembarque y cierre». No se cierra con pasajeros a bordo ni carga en tránsito.
          const [onBoard, cargoPending] = await Promise.all([
            tx.passengerBooking.count({ where: { tripId: t.id, status: { in: ['RESERVADA', 'ABORDO'] } } }),
            tx.cargoShipment.count({ where: { tripId: t.id, status: { in: ['ASIGNADA', 'EN_TRANSITO'] } } }),
          ])
          if (onBoard || cargoPending) {
            throw Errors.conflict(
              'Manifiestos pendientes',
              `Antes de cerrar ${t.code} registre ${[onBoard && `la bajada o ausencia de ${onBoard} pasajero(s)`, cargoPending && `la entrega o excepción de ${cargoPending} carga(s)`].filter(Boolean).join(' y ')} (EVT-008).`,
            )
          }
          const eta = (t.etaUpdated ?? t.plannedEta).getTime() + this.config.ops.arrivalOnTimeToleranceMinutes * 60_000
          const arrived = (t.arrivedAt ?? new Date()).getTime()
          await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'CERRADO', closedAt: new Date(), closedOnTime: arrived <= eta, ...bump } })
          await this.ev(tx, t, p.name, 'CIERRE', 'Viaje cerrado')
          if (t.vehicleId) await tx.vehicle.updateMany({ where: { id: t.vehicleId, lifecycle: 'REGISTRADO' }, data: { lifecycle: 'DISPONIBLE' } })
          after = 'CERRADO'
          break
        }
        case 'cancel': {
          needReason()
          // EXC-009 (SUPUESTO): con pasajeros ya a bordo no se cancela; primero se registra su bajada.
          const boarded = await tx.passengerBooking.count({ where: { tripId: t.id, status: 'ABORDO' } })
          if (boarded) throw Errors.conflict('Pasajeros a bordo', `${boarded} pasajero(s) ya abordaron ${t.code}: registre su bajada antes de cancelar (EXC-009).`)
          await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'CANCELADO', dispatchAuthorized: false, ...bump } })
          await tx.passengerBooking.updateMany({ where: { tripId: t.id, status: 'RESERVADA' }, data: { status: 'CANCELADA', cancelReason: `Viaje cancelado: ${reason}`, version: { increment: 1 } } })
          await tx.cargoShipment.updateMany({ where: { tripId: t.id, status: 'ASIGNADA' }, data: { status: 'REGISTRADA', tripId: null, tripCode: null, vehiclePlate: null, version: { increment: 1 } } })
          await this.ev(tx, t, p.name, 'CAMBIO', 'Viaje cancelado', reason)
          after = 'CANCELADO'
          break
        }
        case 'interrupt': {
          needReason()
          const plan = clean(dto.continuityPlan)
          if (plan.length < 5) throw Errors.field('continuityPlan', 'Indique el plan de continuidad.')
          await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'INTERRUMPIDO', ...bump } })
          await this.ev(tx, t, p.name, 'CAMBIO', `Viaje interrumpido. Plan de continuidad: ${plan}`, reason)
          const pub = await this.notifications.notify({ tenantId: t.tenantId, kind: 'trip.interrupted', severity: 'ALTA', title: 'Viaje interrumpido', body: `${t.code}: ${reason}`, link: `/viajes/${t.id}` }, tx)
          if (pub) effects.push(pub)
          after = 'INTERRUMPIDO'
          break
        }
        case 'reassign': {
          needReason(10)
          const evidence = clean(dto.evidence)
          if (t.lifecycle === 'EN_RUTA' && !evidence) throw Errors.field('evidence', 'La reasignación en ruta requiere evidencia (POL-003).')
          const vehicleId = dto.vehicleId === undefined ? t.vehicleId : dto.vehicleId
          const driverId = dto.driverId === undefined ? t.driverId : dto.driverId
          if (!vehicleId || !driverId) throw Errors.field('vehicleId', 'Un viaje asignado necesita vehículo y conductor.')
          if (vehicleId === t.vehicleId && driverId === t.driverId) throw Errors.field('vehicleId', 'Indique un vehículo o conductor distinto al actual.')
          await this.checkResources(tx, t.plannedDeparture, t.plannedEta, vehicleId !== t.vehicleId ? vehicleId : null, driverId !== t.driverId ? driverId : null, t.id)
          const [v, d] = await Promise.all([tx.vehicle.findFirst({ where: { id: vehicleId } }), tx.driver.findFirst({ where: { id: driverId } })])
          if (!v || !d) throw Errors.field('vehicleId', 'Vehículo o conductor inexistente.')
          // RN-008: se conserva la asignación anterior con motivo, actor, momento y evidencia.
          await tx.tripAssignment.create({ data: { tenantId: t.tenantId, tripId: t.id, vehiclePlate: t.vehiclePlate, driverName: t.driverName, actor: p.name, reason, evidence: evidence || null } })
          const invalidate = t.lifecycle === 'LISTO_PARA_SALIDA'
          await tx.trip.update({ where: { id: t.id }, data: { vehicleId: v.id, vehiclePlate: v.plate, driverId: d.id, driverName: d.name, ...(invalidate ? { lifecycle: 'ASIGNADO', dispatchAuthorized: false } : {}), ...bump } })
          await this.syncBookingsPlate(tx, t.id, v.plate)
          await this.ev(tx, t, p.name, 'CAMBIO', `Reasignación → ${v.plate} / ${d.name}`, reason)
          if (invalidate) {
            await this.ev(tx, t, p.name, 'GATE', 'Habilitación invalidada por cambio de recursos; requiere nueva evaluación')
            after = 'ASIGNADO'
          }
          const pub = await this.notifications.notify({ tenantId: t.tenantId, kind: 'trip.reassigned', severity: 'MEDIA', title: 'Viaje reasignado', body: `${t.code}: ${v.plate} / ${d.name}`, link: `/viajes/${t.id}` }, tx)
          if (pub) effects.push(pub)
          effects.push(() => this.realtime.publish(t.tenantId, { type: 'trip.updated', tripId: t.id }, { driverUserId: d.userId }))
          break
        }
        case 'reschedule': {
          needReason()
          const dep = parseDate(dto.plannedDeparture)
          const eta = parseDate(dto.plannedEta)
          if (!dep || !eta || eta <= dep) throw Errors.field('plannedEta', 'El ETA debe ser posterior a la salida.')
          if (t.vehicleId || t.driverId) await this.checkResources(tx, dep, eta, t.vehicleId, t.driverId, t.id)
          // No se borra la versión anterior: el viaje queda «Reprogramado» y apunta al nuevo (RF-014).
          const n = await tx.trip.create({
            data: {
              tenantId: t.tenantId, code: await this.counters.next(tx, t.tenantId, 'trip'), routeId: t.routeId, routeName: t.routeName, routeVersion: t.routeVersion, baseId: t.baseId, baseName: t.baseName,
              plannedDeparture: dep, plannedEta: eta, vehicleId: t.vehicleId, vehiclePlate: t.vehiclePlate, driverId: t.driverId, driverName: t.driverName, priority: t.priority, instructions: t.instructions,
              lifecycle: t.vehicleId && t.driverId ? 'ASIGNADO' : 'PLANIFICADO', createdBy: p.name, createdByUserId: p.userId, serviceId: t.serviceId, serviceCode: t.serviceCode, serviceName: t.serviceName, customerOrgId: t.customerOrgId,
            },
          })
          await this.ev(tx, n, p.name, 'PLAN', `Reprogramación del viaje ${t.code}`, reason)
          await tx.passengerBooking.updateMany({ where: { tripId: t.id, status: 'RESERVADA' }, data: { tripId: n.id, tripCode: n.code, plannedDeparture: dep } })
          await tx.cargoShipment.updateMany({ where: { tripId: t.id, status: 'ASIGNADA' }, data: { tripId: n.id, tripCode: n.code } })
          await tx.trip.update({ where: { id: t.id }, data: { lifecycle: 'REPROGRAMADO', replacedByTripId: n.id, ...bump } })
          await this.ev(tx, t, p.name, 'CAMBIO', `Reprogramado. Reemplazado por ${n.code}`, reason)
          await this.audit.record({ resourceType: 'Viaje', resourceId: n.code, action: 'trip.create', after: `Reprogramación de ${t.code}` }, tx)
          after = 'REPROGRAMADO'
          resultId = t.id
          break
        }
      }
      if (after !== t.lifecycle || action === 'dispatch' || action === 'reassign') {
        await this.audit.record({ resourceType: 'Viaje', resourceId: t.code, action: `trip.${action}`, before: TRIP_LIFECYCLE.label(before), after: TRIP_LIFECYCLE.label(after), reason: reason || null }, tx)
      }
      effects.push(() => this.realtime.publish(t.tenantId, { type: 'trip.updated', tripId: t.id }, { baseId: t.baseId, driverUserId: null }))
    }).catch(async (e: unknown) => {
      if (e instanceof GateRejection) {
        await this.persistGateRejection(id, e)
        throw Errors.gate(e.gate, e.detail)
      }
      throw e
    })
    effects.forEach((e) => e())
    return this.read.one(resultId)
  }

  /** La evaluación fallida se registra aunque la transición se revierta (evidencia de CTRL-001 y base de KPI-004). */
  private async persistGateRejection(tripId: string, e: GateRejection) {
    const t = await this.prisma.db.trip.findFirst({ where: { id: tripId } })
    if (!t) return
    await this.prisma.db.gateEvaluation.create({ data: { tenantId: t.tenantId, tripId, overall: e.gate.overall, failed: true, requirements: e.gate.requirements as unknown as Prisma.InputJsonValue, action: e.action } })
    const failed = e.gate.requirements.filter((r) => r.severity === 'Crítico' && r.status === 'Falla').map((r) => r.id).join(', ')
    await this.audit.recordSafe({ resourceType: 'Viaje', resourceId: t.code, action: `trip.${e.action}.rejected`, result: 'DENEGADO', before: TRIP_LIFECYCLE.label(t.lifecycle), after: `No habilitado: ${failed}` })
  }
}

class GateRejection extends Error {
  constructor(
    readonly gate: GateResult,
    readonly action: 'enable' | 'dispatch',
    readonly detail?: string,
  ) {
    super('gate')
  }
}
