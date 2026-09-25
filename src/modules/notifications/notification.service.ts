import { Injectable, Logger } from '@nestjs/common'
import type { Notification, NotificationDelivery, Severity } from '../../generated/prisma/client'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { SEVERITY } from '../../common/labels'
import { RealtimePublisher } from '../realtime/realtime.publisher'

export interface NotifyInput {
  tenantId: string
  kind: string
  severity: Severity
  title: string
  body: string
  link?: string | null
  /** Clave de idempotencia de la regla: la misma notificación no se crea dos veces (p. ej. aviso de vencimiento por fase). */
  dedupeKey?: string
}

type NotificationWithDeliveries = Notification & { deliveries: NotificationDelivery[] }

export const notificationView = (n: NotificationWithDeliveries) => ({
  id: n.id,
  kind: n.kind,
  severity: SEVERITY.label(n.severity),
  title: n.title,
  body: n.body,
  createdAt: n.createdAt.toISOString(),
  readAt: n.readAt?.toISOString() ?? null,
  delivery: n.deliveries.map((d) => ({ channel: d.channel, status: d.status === 'ENTREGADA' ? 'Entregada' : d.status === 'FALLIDA' ? 'Fallida' : 'Pendiente', attempts: d.attempts })),
  link: n.link,
})

/**
 * Notificaciones (DOC-E-BE §M · ADR-010). Estado de ENTREGA por canal ≠ estado de GESTIÓN del evento de negocio.
 * Canal disponible: In-app (se entrega al persistir). Email/Push/SMS se modelan como `Pendiente` y los entrega el
 * adaptador que defina DOC-F-INT (no se elige proveedor aquí). El job `notifications.retry` los reintenta.
 */
@Injectable()
export class NotificationService {
  private readonly log = new Logger('Notifications')
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
  ) {}

  /**
   * Crea la notificación dentro de la transacción del caso de uso. Devuelve una función `publish` para emitir el evento
   * en tiempo real DESPUÉS del commit (o `null` si la regla ya había notificado con esa clave).
   */
  async notify(input: NotifyInput, tx?: Tx): Promise<(() => void) | null> {
    const client = tx ?? this.prisma.system
    if (input.dedupeKey) {
      const exists = await client.notification.findFirst({ where: { tenantId: input.tenantId, dedupeKey: input.dedupeKey }, select: { id: true } })
      if (exists) return null
    }
    const n = await client.notification.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
        deliveries: { create: [{ channel: 'In-app', status: 'ENTREGADA', attempts: 1 }] },
      },
      include: { deliveries: true },
    })
    const view = notificationView(n)
    return () => this.realtime.publish(input.tenantId, { type: 'notification.created', notification: view }, { anyPerm: undefined })
  }

  /** Notifica y publica inmediatamente (fuera de transacción; para jobs). */
  async notifyNow(input: NotifyInput): Promise<void> {
    try {
      const publish = await this.notify(input)
      publish?.()
    } catch (e) {
      this.log.error(`No se pudo notificar ${input.kind}: ${(e as Error).message}`)
    }
  }
}
