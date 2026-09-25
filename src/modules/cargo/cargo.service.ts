import { Injectable } from '@nestjs/common'
import type { CargoShipment, CargoStatus, Prisma, ShipmentEvent } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { CARGO_STATUS, TRIP_LIFECYCLE } from '../../common/labels'
import { cutoff, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, parseDate } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { clientDocumentProblem, MastersService, normalizeDoc } from '../masters/masters.service'

type Row = CargoShipment & { events: ShipmentEvent[] }
/** Carga que ocupa lugar en el vehículo (no la entregada ni la cancelada). */
const LOADING: CargoStatus[] = ['ASIGNADA', 'EN_TRANSITO', 'CON_EXCEPCION']
const FLOW: Record<CargoStatus, CargoStatus[]> = {
  REGISTRADA: ['CANCELADA'], ASIGNADA: ['EN_TRANSITO', 'CANCELADA'], EN_TRANSITO: ['ENTREGADA', 'CON_EXCEPCION'], CON_EXCEPCION: ['ENTREGADA', 'CANCELADA'], ENTREGADA: [], CANCELADA: [],
}
const ASSIGNABLE = ['PLANIFICADO', 'ASIGNADO', 'LISTO_PARA_SALIDA'] as const
const kg = (n: number) => `${new Intl.NumberFormat('es').format(n)} kg`
const overdue = (g: CargoShipment, now: number) => g.promisedAt.getTime() < now && !['ENTREGADA', 'CANCELADA'].includes(g.status)

export const cargoView = (g: Row, now = Date.now()) => ({
  id: g.id, code: g.code, documentType: g.documentType, document: g.document, customer: g.customer, cargoType: g.cargoType, description: g.description,
  packages: g.packages, weightKg: g.weightKg, origin: g.origin, destination: g.destination, promisedAt: g.promisedAt.toISOString(), status: CARGO_STATUS.label(g.status),
  tripId: g.tripId, tripCode: g.tripCode, vehiclePlate: g.vehiclePlate, exception: g.exception, receivedBy: g.receivedBy, deliveredAt: g.deliveredAt?.toISOString() ?? null,
  overdue: overdue(g, now), createdBy: g.createdBy, createdAt: g.createdAt.toISOString(), version: g.version,
  events: [...g.events].sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => ({ id: e.id, at: e.at.toISOString(), actor: e.actor, title: e.title, ...(e.detail ? { detail: e.detail } : {}) })),
})

export interface CargoInput {
  documentType: 'RUC' | 'DNI'
  document: string
  customer: string
  cargoType: string
  description: string
  packages: number
  weightKg: number
  origin: string
  destination: string
  promisedAt: string
}

/**
 * Carga (ENT-017 · RF-023/024 · M-007 · modelo PROPUESTO PC-A11, DOC-A no lo detalla). RN-004 (CONFIRMADA): el peso asignado
 * nunca supera la capacidad del vehículo; la aceptación de excepciones de capacidad sigue prohibida hasta GAP-007.
 */
@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly masters: MastersService,
    private readonly counters: CountersService,
  ) {}

  private ev(tx: Tx, g: { id: string; tenantId: string }, actor: string, title: string, detail?: string | null) {
    return tx.shipmentEvent.create({ data: { tenantId: g.tenantId, shipmentId: g.id, actor, title, detail: detail ?? null } })
  }

  private async load(tx: Tx, id: string) {
    return tx.cargoShipment.findFirstOrThrow({ where: { id }, include: { events: true } })
  }

  async list(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['code', 'customer', 'promisedAt', 'status', 'weightKg'], filters: ['status', 'cargoType', 'overdue', 'tripId'], defaultSort: { field: 'createdAt' as string, dir: 'desc' } })
    const db = this.prisma.db
    const now = new Date()
    const overdueWhere: Prisma.CargoShipmentWhereInput = { promisedAt: { lt: now }, status: { notIn: ['ENTREGADA', 'CANCELADA'] } }
    const and: Prisma.CargoShipmentWhereInput[] = []
    const f = q.filters
    if (f.status) {
      const s = CARGO_STATUS.parse(f.status)
      if (!s) throw Errors.field('status', 'Estado desconocido.')
      and.push({ status: s })
    }
    if (f.cargoType) and.push({ cargoType: f.cargoType })
    if (f.overdue) and.push(f.overdue === 'true' ? overdueWhere : { NOT: overdueWhere })
    if (f.tripId) and.push({ tripId: f.tripId })
    if (q.search) {
      const s = { contains: q.search, mode: 'insensitive' as const }
      and.push({ OR: [{ code: s }, { customer: s }, { description: s }, { origin: s }, { destination: s }, { tripCode: s }, { vehiclePlate: s }] })
    }
    const where = { AND: and }
    const orderBy: Prisma.CargoShipmentOrderByWithRelationInput[] = q.sort && q.sort.field !== 'createdAt' ? [{ [q.sort.field]: q.sort.dir }, { id: 'asc' }] : [{ createdAt: 'desc' }]
    const [rows, total, overall, byStatus, byType, late] = await Promise.all([
      db.cargoShipment.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { events: true } }),
      db.cargoShipment.count({ where }),
      db.cargoShipment.count(),
      db.cargoShipment.groupBy({ by: ['status'], _count: { _all: true } }),
      db.cargoShipment.groupBy({ by: ['cargoType'], _count: { _all: true } }),
      db.cargoShipment.count({ where: overdueWhere }),
    ])
    return {
      items: rows.map((g) => cargoView(g, now.getTime())), total, page: q.page, pageSize: q.pageSize, cutoffAt: cutoff(), overall,
      facets: {
        status: Object.fromEntries(byStatus.map((x) => [CARGO_STATUS.label(x.status), x._count._all])),
        cargoType: Object.fromEntries(byType.map((x) => [x.cargoType, x._count._all])),
        overdue: { true: late, false: overall - late },
      },
    }
  }

  private async validate(tx: Tx, i: CargoInput) {
    const errs = new FieldErrors()
    const problem = clientDocumentProblem(i.documentType, i.document)
    if (problem) errs.add('document', problem)
    if (!(await this.masters.isActiveLabel(tx, 'CARGO_TYPE', i.cargoType))) errs.add('cargoType', 'Seleccione un tipo de carga válido.')
    errs.when(clean(i.destination).toLowerCase() === clean(i.origin).toLowerCase(), 'destination', 'El destino debe ser distinto del origen.')
    const promised = parseDate(i.promisedAt)
    errs.when(!promised, 'promisedAt', 'Indique el compromiso de entrega.')
    errs.throwIfAny()
    return promised!
  }

  async create(p: Principal, i: CargoInput) {
    return this.prisma.tx(async (tx) => {
      const promisedAt = await this.validate(tx, i)
      const tenantId = p.tenantId as string
      const g = await tx.cargoShipment.create({
        data: {
          tenantId, code: await this.counters.next(tx, tenantId, 'cargo'), documentType: i.documentType, document: normalizeDoc(i.document), customer: clean(i.customer), cargoType: clean(i.cargoType),
          description: clean(i.description), packages: i.packages, weightKg: i.weightKg, origin: clean(i.origin), destination: clean(i.destination), promisedAt, createdBy: p.name,
        },
      })
      await this.ev(tx, g, p.name, 'Carga registrada')
      await this.masters.upsertClient(tx, tenantId, i.documentType, i.document, i.customer)
      await this.audit.record({ resourceType: 'Carga', resourceId: g.code, action: 'cargo.create', after: `${g.customer} · ${kg(g.weightKg)}` }, tx)
      return cargoView(await this.load(tx, g.id))
    })
  }

  async update(p: Principal, id: string, i: CargoInput) {
    return this.prisma.tx(async (tx) => {
      const g = await tx.cargoShipment.findFirst({ where: { id } })
      if (!g) throw Errors.unavailable()
      if (g.status !== 'REGISTRADA') throw Errors.conflict('Carga no editable', `Una carga «${CARGO_STATUS.label(g.status)}» ya no se edita; el historial se conserva. Cancélela y regístrela de nuevo si es necesario.`)
      if (i.documentType !== g.documentType || normalizeDoc(i.document) !== g.document) throw Errors.field('document', 'El documento identifica al cliente y no se cambia en una carga registrada.')
      const promisedAt = await this.validate(tx, i)
      await tx.cargoShipment.update({
        where: { id },
        data: { customer: clean(i.customer), cargoType: clean(i.cargoType), description: clean(i.description), packages: i.packages, weightKg: i.weightKg, origin: clean(i.origin), destination: clean(i.destination), promisedAt, version: { increment: 1 } },
      })
      await this.ev(tx, g, p.name, 'Datos modificados')
      await this.masters.upsertClient(tx, p.tenantId as string, i.documentType, i.document, i.customer)
      await this.audit.record({ resourceType: 'Carga', resourceId: g.code, action: 'cargo.update', before: `${g.customer} · ${kg(g.weightKg)}`, after: `${clean(i.customer)} · ${kg(i.weightKg)}` }, tx)
      return cargoView(await this.load(tx, id))
    })
  }

  private async loadedKg(tx: Tx, tripId: string, exceptId?: string) {
    const r = await tx.cargoShipment.aggregate({ where: { tripId, status: { in: LOADING }, ...(exceptId ? { id: { not: exceptId } } : {}) }, _sum: { weightKg: true } })
    return r._sum.weightKg ?? 0
  }

  async assignableTrips() {
    const db = this.prisma.db
    const trips = await db.trip.findMany({ where: { lifecycle: { in: [...ASSIGNABLE] } }, orderBy: { plannedDeparture: 'asc' } })
    const vehicles = await db.vehicle.findMany({ where: { id: { in: trips.map((t) => t.vehicleId).filter((x): x is string => !!x) } }, select: { id: true, capacityKg: true } })
    return Promise.all(
      trips.map(async (t) => ({
        id: t.id, code: t.code, routeName: t.routeName, plannedDeparture: t.plannedDeparture.toISOString(), lifecycle: TRIP_LIFECYCLE.label(t.lifecycle), vehiclePlate: t.vehiclePlate,
        capacityKg: vehicles.find((v) => v.id === t.vehicleId)?.capacityKg ?? 0, loadedKg: await this.loadedKg(db, t.id),
      })),
    )
  }

  async assign(p: Principal, id: string, tripId: string) {
    return this.prisma.tx(async (tx) => {
      const g = await tx.cargoShipment.findFirst({ where: { id } })
      if (!g) throw Errors.unavailable()
      if (!['REGISTRADA', 'ASIGNADA'].includes(g.status)) throw Errors.conflict('Estado inválido', `Una carga «${CARGO_STATUS.label(g.status)}» ya no se puede asignar a un viaje.`)
      const t = await tx.trip.findFirst({ where: { id: tripId } })
      if (!t) throw Errors.field('tripId', 'Seleccione un viaje.')
      if (!(ASSIGNABLE as readonly string[]).includes(t.lifecycle)) throw Errors.field('tripId', `El viaje ${t.code} está «${TRIP_LIFECYCLE.label(t.lifecycle)}»: solo se asigna carga antes de la salida.`)
      if (!t.vehicleId) throw Errors.field('tripId', `El viaje ${t.code} aún no tiene vehículo. Asígnelo primero: la capacidad se valida contra el vehículo.`)
      // Serializa asignaciones concurrentes al mismo vehículo: la suma de pesos se valida sin carreras (RN-004).
      await tx.$queryRaw`SELECT "id" FROM "vehicle" WHERE "id" = ${t.vehicleId}::uuid FOR UPDATE`
      const v = await tx.vehicle.findFirstOrThrow({ where: { id: t.vehicleId } })
      const loaded = await this.loadedKg(tx, t.id, g.id)
      if (loaded + g.weightKg > v.capacityKg) {
        throw Errors.field('tripId', `Capacidad excedida (RN-004 · EXC-015): ${v.plate} admite ${kg(v.capacityKg)} y ya lleva ${kg(loaded)}; esta carga suma ${kg(g.weightKg)} (disponible: ${kg(Math.max(0, v.capacityKg - loaded))}).`)
      }
      await tx.cargoShipment.update({ where: { id }, data: { status: 'ASIGNADA', tripId: t.id, tripCode: t.code, vehiclePlate: v.plate, version: { increment: 1 } } })
      await this.ev(tx, g, p.name, g.tripCode ? `Reasignada al viaje ${t.code}` : `Asignada al viaje ${t.code}`, v.plate)
      await this.audit.record({ resourceType: 'Carga', resourceId: g.code, action: 'cargo.assign', before: g.tripCode, after: `${t.code} · ${v.plate}` }, tx)
      return cargoView(await this.load(tx, id))
    })
  }

  async advance(p: Principal, id: string, i: { to: string; reason?: string; receivedBy?: string }) {
    const to = CARGO_STATUS.parse(i.to)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    return this.prisma.tx(async (tx) => {
      const g = await tx.cargoShipment.findFirst({ where: { id } })
      if (!g) throw Errors.unavailable()
      if (!FLOW[g.status].includes(to)) throw Errors.conflict('Transición inválida', `No se puede pasar de «${CARGO_STATUS.label(g.status)}» a «${i.to}».`)
      const why = clean(i.reason)
      if (to === 'EN_TRANSITO') {
        const t = g.tripId ? await tx.trip.findFirst({ where: { id: g.tripId } }) : null
        if (t?.lifecycle !== 'EN_RUTA') throw Errors.conflict('El viaje aún no sale', `El viaje ${g.tripCode ?? ''} está «${t ? TRIP_LIFECYCLE.label(t.lifecycle) : 'sin viaje'}»: la carga pasa a tránsito cuando el viaje está en ruta.`)
      }
      if (to === 'ENTREGADA' && clean(i.receivedBy).length < 3) throw Errors.field('receivedBy', 'Indique quién recibió la carga.')
      if ((to === 'CON_EXCEPCION' || to === 'CANCELADA') && why.length < 5) throw Errors.field('reason', to === 'CANCELADA' ? 'Indique el motivo de la cancelación (mín. 5 caracteres).' : 'Describa la excepción (mín. 5 caracteres).')
      await tx.cargoShipment.update({
        where: { id },
        data: {
          status: to, version: { increment: 1 },
          ...(to === 'CON_EXCEPCION' ? { exception: why, hadException: true } : {}),
          ...(to === 'ENTREGADA' ? { receivedBy: clean(i.receivedBy), deliveredAt: new Date(), exception: null } : {}),
          ...(to === 'CANCELADA' ? { exception: null } : {}),
        },
      })
      await this.ev(tx, g, p.name, to === 'CON_EXCEPCION' ? 'Excepción registrada' : CARGO_STATUS.label(to), to === 'ENTREGADA' ? `Recibió: ${clean(i.receivedBy)}` : why || null)
      const action = { EN_TRANSITO: 'cargo.transit', ENTREGADA: 'cargo.deliver', CON_EXCEPCION: 'cargo.exception', CANCELADA: 'cargo.cancel' }[to as 'EN_TRANSITO']
      await this.audit.record({ resourceType: 'Carga', resourceId: g.code, action: action ?? 'cargo.advance', before: CARGO_STATUS.label(g.status), after: i.to, reason: why || null }, tx)
      return cargoView(await this.load(tx, id))
    })
  }
}
