import { Injectable } from '@nestjs/common'
import type { DispatchMessage, Trip } from '../../generated/prisma/client'
import { Errors } from '../../common/errors/app-error'
import { clean } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { hasPerm, type Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { RealtimePublisher } from '../realtime/realtime.publisher'

export const messageView = (m: DispatchMessage) => ({
  id: m.id,
  tripId: m.tripId,
  tripCode: m.tripCode,
  vehiclePlate: m.vehiclePlate,
  from: m.from === 'CONTROL' ? 'Control' : 'Conductor',
  authorName: m.authorName,
  text: m.text,
  sentAt: m.sentAt.toISOString(),
})

/**
 * Mensajería control ↔ conductor por viaje (PC-A15 · PERM-029 PROPUESTO). Texto auditable; no reemplaza radio/telefonía.
 * El conductor envía por `POST /driver/actions` (offline-safe, idempotente); control por `POST /trips/{id}/messages`.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimePublisher,
  ) {}

  private async driverOwns(tx: Tx, p: Principal, t: Trip): Promise<boolean> {
    if (!t.driverId || !p.roles.includes('ROL-008')) return false
    const d = await tx.driver.findFirst({ where: { userId: p.userId }, select: { id: true } })
    return d?.id === t.driverId
  }

  async list(p: Principal, tripId: string) {
    const db = this.prisma.db
    const t = await db.trip.findFirst({ where: { id: tripId } })
    if (!t) throw Errors.unavailable('El viaje no existe o está fuera de su alcance.')
    const own = await this.driverOwns(db, p, t)
    if (!own) {
      if (!hasPerm(p, 'tracking.view', 'dispatch.message')) throw Errors.forbidden()
      if (!new DataScope(p).covers(t.baseId)) throw Errors.unavailable('El viaje está fuera de su alcance.')
    }
    const rows = await db.dispatchMessage.findMany({ where: { tripId }, orderBy: { sentAt: 'asc' } })
    return rows.map(messageView)
  }

  async send(p: Principal, tripId: string, text: string) {
    const body = clean(text)
    if (!body) throw Errors.field('text', 'Escriba un mensaje.')
    const msg = await this.prisma.tx(async (tx) => {
      const t = await tx.trip.findFirst({ where: { id: tripId } })
      if (!t || !new DataScope(p).covers(t.baseId)) throw Errors.unavailable('El viaje no existe o está fuera de su alcance.')
      const m = await tx.dispatchMessage.create({
        data: { tenantId: t.tenantId, tripId: t.id, tripCode: t.code, vehiclePlate: t.vehiclePlate, from: 'CONTROL', authorName: p.name, authorId: p.userId, text: body, sentAt: new Date() },
      })
      await this.audit.record({ resourceType: 'Mensaje', resourceId: t.code, action: 'message.send', after: body.slice(0, 80) }, tx)
      const driver = t.driverId ? await tx.driver.findFirst({ where: { id: t.driverId }, select: { userId: true } }) : null
      return { m, t, driverUserId: driver?.userId ?? null }
    })
    this.realtime.publish(msg.t.tenantId, { type: 'message.created', message: messageView(msg.m) }, { anyPerm: ['tracking.view', 'dispatch.message'], baseId: msg.t.baseId, driverUserId: msg.driverUserId })
    return messageView(msg.m)
  }

  /** Mensaje del conductor (llega por su outbox). `occurredAt` = hora del dispositivo; el servidor registra también la de recepción. */
  async fromDriver(tx: Tx, p: Principal, t: Trip, text: string, occurredAt: Date) {
    const m = await tx.dispatchMessage.create({
      data: { tenantId: t.tenantId, tripId: t.id, tripCode: t.code, vehiclePlate: t.vehiclePlate, from: 'CONDUCTOR', authorName: p.name, authorId: p.userId, text: clean(text), sentAt: occurredAt },
    })
    await this.audit.record({ resourceType: 'Mensaje', resourceId: t.code, action: 'message.send', after: 'Enviado por el conductor (app)' }, tx)
    return () => this.realtime.publish(t.tenantId, { type: 'message.created', message: messageView(m) }, { anyPerm: ['tracking.view', 'dispatch.message'], baseId: t.baseId, driverUserId: p.userId })
  }
}
