import { Injectable } from '@nestjs/common'
import type { BookingEvent, PassengerBooking, PassengerDocumentType, PassengerStatus, Prisma, Trip } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { PAX_DOC, PAX_STATUS, TRIP_LIFECYCLE } from '../../common/labels'
import { cutoff, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, iso } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { canAlight, canBoard, freeSeatsIn, overlaps, PASSENGER_CLASSES, parsePoints, peakOccupancy, routeStops, SEATED, seatsTakenIn, spanOf, type RouteStop } from '../planning/domain/stops'

type Row = PassengerBooking & { events: BookingEvent[] }
const FLOW: Record<PassengerStatus, PassengerStatus[]> = { RESERVADA: ['ABORDO', 'NO_SE_PRESENTO', 'CANCELADA'], ABORDO: ['LLEGO'], LLEGO: [], NO_SE_PRESENTO: [], CANCELADA: [] }
export const BOOKABLE = ['PLANIFICADO', 'ASIGNADO', 'LISTO_PARA_SALIDA'] as const
const isBookable = (l: string) => (BOOKABLE as readonly string[]).includes(l)
const fullName = (x: { firstNames: string; lastNamePaternal: string; lastNameMaternal: string }) => `${x.firstNames.trim()} ${x.lastNamePaternal.trim()}${x.lastNameMaternal.trim() ? ` ${x.lastNameMaternal.trim()}` : ''}`

export const bookingView = (x: Row) => ({
  id: x.id, code: x.code, documentType: PAX_DOC.label(x.documentType), document: x.document, lastNamePaternal: x.lastNamePaternal, lastNameMaternal: x.lastNameMaternal,
  firstNames: x.firstNames, passengerName: fullName(x), phone: x.phone, reducedMobility: x.reducedMobility, tripId: x.tripId, tripCode: x.tripCode, routeName: x.routeName,
  plannedDeparture: x.plannedDeparture.toISOString(), vehiclePlate: x.vehiclePlate, boardStop: x.boardStop, alightStop: x.alightStop, seat: x.seat, status: PAX_STATUS.label(x.status),
  cancelReason: x.cancelReason, createdBy: x.createdBy, createdAt: x.createdAt.toISOString(), version: x.version,
  events: [...x.events].sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => ({ id: e.id, at: e.at.toISOString(), actor: e.actor, title: e.title, ...(e.detail ? { detail: e.detail } : {}) })),
})

/** DNI: 8 dígitos. CE/Pasaporte: sin formato fijo, mínimo razonable. */
export function paxDocumentProblem(t: PassengerDocumentType, doc: string): string | null {
  const d = clean(doc)
  if (t === 'DNI') return /^\d{8}$/.test(d) ? null : 'El DNI debe tener 8 dígitos.'
  return d.length < 5 ? 'Indique el documento de identidad (mín. 5 caracteres).' : null
}

export interface PassengerInput {
  documentType: string
  document: string
  lastNamePaternal: string
  lastNameMaternal: string
  firstNames: string
  phone: string
  reducedMobility: boolean
  tripId: string
  boardStop: string
  alightStop: string
  seat: number | null
}

/**
 * Pasajeros (ENT-018 · RF-025/026 · M-008 · modelo PROPUESTO PC-A6/PC-A16). Datos personales (NFR-007): documento y teléfono
 * solo para quien gestiona pasajeros; el portal y la búsqueda pública nunca exponen datos de terceros.
 * RN-003 (CONFIRMADA): nunca más pasajeros que asientos en ningún tramo. Tarifas/pagos: fuera de alcance (decisión de negocio).
 */
@Injectable()
export class PassengersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
  ) {}

  private ev(tx: Tx, b: { id: string; tenantId: string }, actor: string, title: string, detail?: string | null) {
    return tx.bookingEvent.create({ data: { tenantId: b.tenantId, bookingId: b.id, actor, title, detail: detail ?? null } })
  }

  /** Viaje de pasajeros con sus cupos (null si no es de pasajeros o no tiene vehículo/paradas). */
  async tripOption(tx: Tx, t: Trip) {
    if (!t.vehicleId) return null
    const [v, r, items] = await Promise.all([
      tx.vehicle.findFirst({ where: { id: t.vehicleId } }),
      tx.route.findFirst({ where: { id: t.routeId } }),
      tx.passengerBooking.findMany({ where: { tripId: t.id }, select: { id: true, seat: true, status: true, boardStop: true, alightStop: true } }),
    ])
    const stops: RouteStop[] = r ? routeStops(parsePoints(r.points)) : []
    if (!v || !PASSENGER_CLASSES.includes(v.vehicleClass) || stops.length < 2) return null
    return {
      id: t.id, code: t.code, routeName: t.routeName, plannedDeparture: t.plannedDeparture.toISOString(), lifecycle: TRIP_LIFECYCLE.label(t.lifecycle), vehiclePlate: v.plate,
      driverName: t.driverName, capacity: v.capacityPassengers, stops, booked: items.filter((x) => (SEATED as readonly string[]).includes(x.status)).length, peak: peakOccupancy(stops, items),
      items,
    }
  }

  async list(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['code', 'passengerName', 'plannedDeparture', 'seat', 'status'], filters: ['status', 'tripId', 'reducedMobility'], defaultSort: { field: 'plannedDeparture', dir: 'desc' } })
    const db = this.prisma.db
    const and: Prisma.PassengerBookingWhereInput[] = []
    const f = q.filters
    if (f.status) {
      const s = PAX_STATUS.parse(f.status)
      if (!s) throw Errors.field('status', 'Estado desconocido.')
      and.push({ status: s })
    }
    if (f.tripId) and.push({ tripId: f.tripId })
    if (f.reducedMobility) and.push({ reducedMobility: f.reducedMobility === 'true' })
    if (q.search) {
      const s = { contains: q.search, mode: 'insensitive' as const }
      and.push({ OR: [{ code: s }, { document: s }, { firstNames: s }, { lastNamePaternal: s }, { lastNameMaternal: s }, { tripCode: s }, { routeName: s }, { vehiclePlate: s }, { boardStop: s }, { alightStop: s }] })
    }
    const where = { AND: and }
    const sortField = q.sort?.field === 'passengerName' ? 'lastNamePaternal' : q.sort?.field
    const orderBy: Prisma.PassengerBookingOrderByWithRelationInput[] = q.sort && sortField ? [{ [sortField]: q.sort.dir }, { id: 'asc' }] : [{ plannedDeparture: 'desc' }]
    const [rows, total, overall, byStatus, rm] = await Promise.all([
      db.passengerBooking.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { events: true } }),
      db.passengerBooking.count({ where }),
      db.passengerBooking.count(),
      db.passengerBooking.groupBy({ by: ['status'], _count: { _all: true } }),
      db.passengerBooking.count({ where: { reducedMobility: true } }),
    ])
    return {
      items: rows.map(bookingView), total, page: q.page, pageSize: q.pageSize, cutoffAt: cutoff(), overall,
      facets: { status: Object.fromEntries(byStatus.map((x) => [PAX_STATUS.label(x.status), x._count._all])), reducedMobility: { true: rm, false: overall - rm } },
    }
  }

  async assignableTrips() {
    const db = this.prisma.db
    const trips = await db.trip.findMany({ where: { lifecycle: { in: [...BOOKABLE] } }, orderBy: { plannedDeparture: 'asc' } })
    const opts = await Promise.all(trips.map((t) => this.tripOption(db, t)))
    return opts.filter((o): o is NonNullable<typeof o> => !!o).map(({ items: _i, ...o }) => o)
  }

  async manifest(tripId: string) {
    const db = this.prisma.db
    const t = await db.trip.findFirst({ where: { id: tripId } })
    const opt = t ? await this.tripOption(db, t) : null
    if (!opt) throw Errors.unavailable()
    const items = await db.passengerBooking.findMany({ where: { tripId }, orderBy: { seat: 'asc' }, include: { events: true } })
    const { items: _i, ...trip } = opt
    return { trip, items: items.map(bookingView) }
  }

  async lookup(documentType: string, document: string) {
    const t = PAX_DOC.parse(documentType)
    if (!t) throw Errors.field('documentType', 'Tipo de documento inválido.')
    const p = await this.prisma.db.passengerProfile.findFirst({ where: { documentType: t, document: clean(document).toUpperCase() } })
    if (!p) throw Errors.notFound('El documento aún no está registrado.')
    return { documentType: PAX_DOC.label(p.documentType), document: p.document, lastNamePaternal: p.lastNamePaternal, lastNameMaternal: p.lastNameMaternal, firstNames: p.firstNames }
  }

  async create(p: Principal, i: PassengerInput) {
    const docType = PAX_DOC.parse(i.documentType)
    if (!docType) throw Errors.field('documentType', 'Tipo de documento inválido.')
    const errs = new FieldErrors()
    const docProblem = paxDocumentProblem(docType, i.document)
    if (docProblem) errs.add('document', docProblem)
    errs.when(!!clean(i.phone) && clean(i.phone).replace(/\D/g, '').length < 7, 'phone', 'El teléfono debe tener al menos 7 dígitos.')
    errs.throwIfAny()
    const doc = clean(i.document).toUpperCase()
    return this.prisma.tx(async (tx) => {
      // Serializa las reservas del mismo viaje: dos altas simultáneas no pueden tomar el mismo asiento (RN-003).
      await tx.$queryRaw`SELECT "id" FROM "trip" WHERE "id" = ${i.tripId}::uuid FOR UPDATE`
      const t = await tx.trip.findFirst({ where: { id: i.tripId } })
      const trip = t && isBookable(t.lifecycle) ? await this.tripOption(tx, t) : null
      if (!t || !trip) throw Errors.field('tripId', t ? `El viaje ${t.code} no admite reservas: ya salió o no es un viaje de pasajeros con vehículo asignado.` : 'Seleccione un viaje.')
      const span = spanOf(trip.stops, i.boardStop, i.alightStop)
      const from = trip.stops[span[0]]
      const to = trip.stops[span[1]]
      const e2 = new FieldErrors()
      if (!from || !canBoard(from)) e2.add('boardStop', from ? `En «${from.name}» solo bajan pasajeros: elija otra parada para subir.` : 'Seleccione la parada donde sube.')
      if (!to || !canAlight(to)) e2.add('alightStop', to ? `En «${to.name}» solo suben pasajeros: elija otra parada para bajar.` : 'Seleccione la parada donde baja.')
      else if (from && span[0] >= span[1]) e2.add('alightStop', 'La parada de bajada debe ser posterior a la de subida.')
      e2.throwIfAny()
      const all = await tx.passengerBooking.findMany({ where: { tripId: t.id }, select: { id: true, code: true, seat: true, status: true, boardStop: true, alightStop: true, documentType: true, document: true } })
      const dup = all.find((x) => x.documentType === docType && x.document === doc && (SEATED as readonly string[]).includes(x.status) && overlaps(spanOf(trip.stops, x.boardStop, x.alightStop), span))
      if (dup) throw Errors.field('document', `Este pasajero ya tiene la reserva ${dup.code} en ${t.code} de ${dup.boardStop} a ${dup.alightStop} (asiento ${dup.seat}): los tramos se cruzan.`)
      const taken = seatsTakenIn(trip.stops, all, span)
      const free = freeSeatsIn(trip.capacity, taken)
      if (!free.length) throw Errors.field('tripId', `Sin asientos libres de ${i.boardStop} a ${i.alightStop}: ${trip.vehiclePlate} tiene ${trip.capacity} y todos están ocupados en ese tramo (RN-003).`)
      let seat = i.seat
      if (seat === null) seat = free[0]!
      else if (!Number.isInteger(seat) || seat < 1 || seat > trip.capacity) throw Errors.field('seat', `El asiento debe estar entre 1 y ${trip.capacity}.`)
      else if (taken.has(seat)) throw Errors.field('seat', `El asiento ${seat} ya está ocupado entre ${i.boardStop} y ${i.alightStop}.`)
      const tenantId = p.tenantId as string
      const names = { lastNamePaternal: clean(i.lastNamePaternal), lastNameMaternal: clean(i.lastNameMaternal), firstNames: clean(i.firstNames) }
      const b = await tx.passengerBooking.create({
        data: {
          tenantId, code: await this.counters.next(tx, tenantId, 'booking'), documentType: docType, document: doc, ...names, phone: clean(i.phone) || null, reducedMobility: i.reducedMobility,
          tripId: t.id, tripCode: t.code, routeName: t.routeName, plannedDeparture: t.plannedDeparture, vehiclePlate: trip.vehiclePlate, boardStop: i.boardStop, alightStop: i.alightStop, seat, createdBy: p.name,
        },
      })
      await this.ev(tx, b, p.name, 'Reserva registrada', `${i.boardStop} → ${i.alightStop} · asiento ${seat}`)
      await tx.passengerProfile.upsert({ where: { tenantId_documentType_document: { tenantId, documentType: docType, document: doc } }, create: { tenantId, documentType: docType, document: doc, ...names }, update: names })
      await this.audit.record({ resourceType: 'Reserva', resourceId: b.code, action: 'passenger.create', after: `${t.code} · ${i.boardStop} → ${i.alightStop} · asiento ${seat}` }, tx)
      return bookingView(await tx.passengerBooking.findFirstOrThrow({ where: { id: b.id }, include: { events: true } }))
    })
  }

  async update(p: Principal, id: string, i: { lastNamePaternal: string; lastNameMaternal: string; firstNames: string; phone: string; reducedMobility: boolean; seat: number }) {
    return this.prisma.tx(async (tx) => {
      const x = await tx.passengerBooking.findFirst({ where: { id } })
      if (!x) throw Errors.unavailable()
      await tx.$queryRaw`SELECT "id" FROM "trip" WHERE "id" = ${x.tripId}::uuid FOR UPDATE`
      if (x.status !== 'RESERVADA') throw Errors.conflict('Reserva no editable', `Una reserva «${PAX_STATUS.label(x.status)}» ya no se edita; el historial se conserva.`)
      const t = await tx.trip.findFirstOrThrow({ where: { id: x.tripId } })
      const trip = await this.tripOption(tx, t)
      const cap = trip?.capacity ?? x.seat
      if (!Number.isInteger(i.seat) || i.seat < 1 || i.seat > cap) throw Errors.field('seat', `El asiento debe estar entre 1 y ${cap}.`)
      if (trip && seatsTakenIn(trip.stops, trip.items, spanOf(trip.stops, x.boardStop, x.alightStop), x.id).has(i.seat)) throw Errors.field('seat', `El asiento ${i.seat} ya está ocupado entre ${x.boardStop} y ${x.alightStop}.`)
      if (clean(i.phone) && clean(i.phone).replace(/\D/g, '').length < 7) throw Errors.field('phone', 'El teléfono debe tener al menos 7 dígitos.')
      const names = { lastNamePaternal: clean(i.lastNamePaternal), lastNameMaternal: clean(i.lastNameMaternal), firstNames: clean(i.firstNames) }
      await tx.passengerBooking.update({ where: { id }, data: { ...names, phone: clean(i.phone) || null, reducedMobility: i.reducedMobility, seat: i.seat, version: { increment: 1 } } })
      // Nunca capturar un error dentro de una transacción de PostgreSQL (la dejaría abortada): upsert en vez de update+catch.
      const key = { tenantId: x.tenantId, documentType: x.documentType, document: x.document }
      await tx.passengerProfile.upsert({ where: { tenantId_documentType_document: key }, create: { ...key, ...names }, update: names })
      await this.ev(tx, x, p.name, 'Datos modificados', `Asiento ${i.seat}`)
      await this.audit.record({ resourceType: 'Reserva', resourceId: x.code, action: 'passenger.update', before: `asiento ${x.seat}${x.reducedMobility ? ' · asistencia' : ''}`, after: `asiento ${i.seat}${i.reducedMobility ? ' · asistencia' : ''}` }, tx)
      return bookingView(await tx.passengerBooking.findFirstOrThrow({ where: { id }, include: { events: true } }))
    })
  }

  async advance(p: Principal, id: string, i: { to: string; reason?: string }) {
    const to = PAX_STATUS.parse(i.to)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    return this.prisma.tx(async (tx) => {
      const x = await tx.passengerBooking.findFirst({ where: { id } })
      if (!x) throw Errors.unavailable()
      if (!FLOW[x.status].includes(to)) throw Errors.conflict('Transición inválida', `No se puede pasar de «${PAX_STATUS.label(x.status)}» a «${i.to}».`)
      const t = await tx.trip.findFirstOrThrow({ where: { id: x.tripId } })
      const life = t.lifecycle
      const L = TRIP_LIFECYCLE.label(life)
      const why = clean(i.reason)
      if (to === 'ABORDO' && !['LISTO_PARA_SALIDA', 'EN_RUTA'].includes(life)) throw Errors.conflict('Aún no se puede abordar', `El viaje ${x.tripCode} está «${L}»: el abordaje se registra cuando está listo para salir o en ruta.`)
      if (to === 'NO_SE_PRESENTO' && !['EN_RUTA', 'EN_DESTINO', 'CERRADO'].includes(life)) throw Errors.conflict('El viaje aún no sale', `El viaje ${x.tripCode} está «${L}»: solo se marca «No se presentó» cuando ya salió.`)
      if (to === 'LLEGO') {
        const r = await tx.route.findFirst({ where: { id: t.routeId } })
        const stops = r ? routeStops(parsePoints(r.points)) : []
        const last = spanOf(stops, x.boardStop, x.alightStop)[1] === stops.length - 1
        const ok = last ? ['EN_DESTINO', 'CERRADO'] : ['EN_RUTA', 'EN_DESTINO', 'CERRADO']
        if (!ok.includes(life)) throw Errors.conflict('El viaje aún no llega', last ? `El viaje ${x.tripCode} está «${L}»: la llegada a ${x.alightStop} se registra cuando está en destino.` : `El viaje ${x.tripCode} está «${L}»: la bajada en ${x.alightStop} se registra con el viaje en ruta.`)
      }
      if (to === 'CANCELADA') {
        if (!isBookable(life)) throw Errors.conflict('El viaje ya salió', `El viaje ${x.tripCode} está «${L}»: ya no se cancela la reserva; márquela «No se presentó».`)
        if (why.length < 5) throw Errors.field('reason', 'Indique el motivo de la cancelación (mín. 5 caracteres).')
      }
      await tx.passengerBooking.update({ where: { id }, data: { status: to, version: { increment: 1 }, ...(to === 'CANCELADA' ? { cancelReason: why } : {}) } })
      const title = { ABORDO: 'Abordó', LLEGO: 'Llegó a destino', NO_SE_PRESENTO: 'No se presentó', CANCELADA: 'Reserva cancelada', RESERVADA: 'Reservada' }[to]
      await this.ev(tx, x, p.name, title, to === 'CANCELADA' ? why : to === 'ABORDO' ? `Subió en ${x.boardStop}` : to === 'LLEGO' ? `Bajó en ${x.alightStop}` : null)
      const action = { ABORDO: 'passenger.board', LLEGO: 'passenger.arrive', NO_SE_PRESENTO: 'passenger.noshow', CANCELADA: 'passenger.cancel', RESERVADA: 'passenger.advance' }[to]
      await this.audit.record({ resourceType: 'Reserva', resourceId: x.code, action, before: PAX_STATUS.label(x.status), after: i.to, reason: to === 'CANCELADA' ? why : null }, tx)
      return bookingView(await tx.passengerBooking.findFirstOrThrow({ where: { id }, include: { events: true } }))
    })
  }

  /* ───── vista del propio pasajero (portal y búsqueda pública comparten forma y regla de cancelación) ───── */

  async portalView(tx: Tx, rows: PassengerBooking[]) {
    const trips = await tx.trip.findMany({ where: { id: { in: rows.map((r) => r.tripId) } } })
    return rows
      .map((x) => {
        const t = trips.find((y) => y.id === x.tripId)
        return {
          id: x.id, code: x.code, tripCode: x.tripCode, routeName: x.routeName, boardStop: x.boardStop, alightStop: x.alightStop,
          plannedDeparture: (t?.plannedDeparture ?? x.plannedDeparture).toISOString(), plannedEta: t?.plannedEta.toISOString() ?? x.plannedDeparture.toISOString(), etaUpdated: iso(t?.etaUpdated),
          tripLifecycle: t ? TRIP_LIFECYCLE.label(t.lifecycle) : 'Planificado', vehiclePlate: x.vehiclePlate, seat: x.seat, status: PAX_STATUS.label(x.status),
          reducedMobility: x.reducedMobility, canCancel: x.status === 'RESERVADA' && !!t && isBookable(t.lifecycle), cancelReason: x.cancelReason,
        }
      })
      .sort((a, b) => b.plannedDeparture.localeCompare(a.plannedDeparture))
  }

  async cancelOwn(tx: Tx, x: PassengerBooking, reason: string | undefined, actor: string, action: string) {
    const t = await tx.trip.findFirst({ where: { id: x.tripId } })
    if (x.status !== 'RESERVADA' || !t || !isBookable(t.lifecycle)) {
      throw Errors.conflict('No se puede cancelar', x.status !== 'RESERVADA' ? `Su reserva está «${PAX_STATUS.label(x.status)}».` : `El viaje ${x.tripCode} ya salió: comuníquese con la empresa.`)
    }
    const why = clean(reason) || 'Cancelada por el pasajero'
    await tx.passengerBooking.update({ where: { id: x.id }, data: { status: 'CANCELADA', cancelReason: why, version: { increment: 1 } } })
    await this.ev(tx, x, actor, 'Reserva cancelada por el pasajero', why)
    await this.audit.record({ resourceType: 'Reserva', resourceId: x.code, action, before: 'Reservada', after: 'Cancelada', reason: why, actorName: actor }, tx)
    const next = await tx.passengerBooking.findFirstOrThrow({ where: { id: x.id } })
    return (await this.portalView(tx, [next]))[0]!
  }

  /** «Mis reservas» (PC-A9): el servidor resuelve por el documento de la CUENTA; el cliente nunca envía un documento. */
  async mine(p: Principal) {
    if (!p.document) return []
    const rows = await this.prisma.db.passengerBooking.findMany({ where: { document: p.document.toUpperCase() } })
    return this.portalView(this.prisma.db, rows)
  }

  async cancelMine(p: Principal, id: string, reason?: string) {
    return this.prisma.tx(async (tx) => {
      const x = p.document ? await tx.passengerBooking.findFirst({ where: { id, document: p.document.toUpperCase() } }) : null
      if (!x) throw Errors.unavailable() // ni la existencia de reservas ajenas se revela
      return this.cancelOwn(tx, x, reason, p.name, 'passenger.self.cancel')
    })
  }
}
