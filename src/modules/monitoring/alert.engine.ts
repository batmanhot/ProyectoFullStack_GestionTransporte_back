import { Injectable } from '@nestjs/common'
import type { Alert, AlertKind, Severity } from '../../generated/prisma/client'
import { ALERT_KIND, ALERT_STATUS, SEVERITY, SEVERITY_RANK } from '../../common/labels'
import { iso } from '../../common/http/params'
import type { Tx } from '../../database/prisma.service'
import { NotificationService } from '../notifications/notification.service'
import { RealtimePublisher } from '../realtime/realtime.publisher'

export const alertView = (a: Alert, files: { id: string; name: string; size: number; type: string }[] = []) => ({
  id: a.id,
  kind: ALERT_KIND.label(a.kind),
  severity: SEVERITY.label(a.severity),
  status: ALERT_STATUS.label(a.status),
  tripId: a.tripId,
  tripCode: a.tripCode,
  vehiclePlate: a.vehiclePlate,
  detail: a.detail,
  createdAt: a.createdAt.toISOString(),
  assignee: a.assignee,
  incidentId: a.incidentId,
  evidence: a.evidence,
  // Estado de ENTREGA de la notificación (ADR-010), distinto del estado de GESTIÓN de la alerta.
  notification: { channel: 'In-app' as const, status: 'Entregada' as const },
  requiresReview: a.requiresReview,
  version: a.version,
  ...(files.length ? { evidenceFiles: files.map((f) => ({ fileId: f.id, name: f.name, size: f.size, type: f.type })) } : {}),
  documentId: a.documentId,
  subject: a.subject,
  dueAt: iso(a.dueAt),
  phase: (a.phase as 'Por vencer' | 'Vencido' | null) ?? null,
})

export interface RaiseInput {
  tenantId: string
  kind: AlertKind
  severity: Severity
  detail: string
  /** Una alerta ABIERTA por clave (índice único parcial en BD): la regla es idempotente. */
  dedupeKey: string
  tripId?: string | null
  tripCode?: string | null
  vehicleId?: string | null
  vehiclePlate?: string | null
  baseId?: string | null
  assignee?: string | null
  documentId?: string | null
  subject?: string | null
  dueAt?: Date | null
  phase?: string | null
  notifyTitle?: string
}

/**
 * Motor de alertas (RF-018–020 · RN-007 · EVT-004/005). Detección ≠ gestión: el motor crea o ESCALA alertas; las personas las gestionan.
 *  - Idempotente por `dedupeKey` (no duplica una alerta abierta de la misma condición).
 *  - Si la condición empeora, escala la MISMA alerta (severidad/fase) en lugar de abrir otra.
 *  - «Alta»/«Crítica» exigen revisión senior para cerrarse (política de seguridad [PROPUESTO] de PROC-004).
 */
@Injectable()
export class AlertEngine {
  constructor(
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async raise(tx: Tx, i: RaiseInput): Promise<{ alert: Alert; created: boolean; escalated: boolean; effects: (() => void)[] }> {
    const effects: (() => void)[] = []
    const open = await tx.alert.findFirst({ where: { tenantId: i.tenantId, dedupeKey: i.dedupeKey, status: { notIn: ['RESUELTA', 'CERRADA'] } } })
    if (open) {
      const worse = SEVERITY_RANK[i.severity] > SEVERITY_RANK[open.severity] || (i.phase && i.phase !== open.phase)
      if (!worse) return { alert: open, created: false, escalated: false, effects }
      const upd = await tx.alert.update({
        where: { id: open.id },
        data: { severity: SEVERITY_RANK[i.severity] > SEVERITY_RANK[open.severity] ? i.severity : open.severity, detail: i.detail, phase: i.phase ?? open.phase, dueAt: i.dueAt ?? open.dueAt, requiresReview: open.requiresReview || ['ALTA', 'CRITICA'].includes(i.severity), version: { increment: 1 } },
      })
      const pub = await this.notifications.notify({ tenantId: i.tenantId, kind: `alert.escalated.${ALERT_KIND.label(i.kind)}`, severity: upd.severity, title: `${i.notifyTitle ?? ALERT_KIND.label(i.kind)}: escalada`, body: i.detail, link: '/monitoreo/alertas' }, tx)
      if (pub) effects.push(pub)
      return { alert: upd, created: false, escalated: true, effects }
    }
    const a = await tx.alert.create({
      data: {
        tenantId: i.tenantId, kind: i.kind, severity: i.severity, detail: i.detail, dedupeKey: i.dedupeKey, tripId: i.tripId ?? null, tripCode: i.tripCode ?? null,
        vehicleId: i.vehicleId ?? null, vehiclePlate: i.vehiclePlate ?? null, assignee: i.assignee ?? null, documentId: i.documentId ?? null, subject: i.subject ?? null,
        dueAt: i.dueAt ?? null, phase: i.phase ?? null, requiresReview: ['ALTA', 'CRITICA'].includes(i.severity),
      },
    })
    if (a.tripId) await tx.tripEvent.create({ data: { tenantId: i.tenantId, tripId: a.tripId, actor: 'Sistema', kind: 'ALERTA', summary: `${ALERT_KIND.label(a.kind)}: ${a.detail}` } })
    const pub = await this.notifications.notify({ tenantId: i.tenantId, kind: `alert.${ALERT_KIND.label(i.kind)}`, severity: a.severity, title: i.notifyTitle ?? ALERT_KIND.label(i.kind), body: i.detail, link: '/monitoreo/alertas' }, tx)
    if (pub) effects.push(pub)
    const view = alertView(a)
    effects.push(() => this.realtime.publish(i.tenantId, { type: 'alert.created', alert: view }, { anyPerm: i.kind === 'VENCIMIENTO' ? ['alert.manage', 'document.manage'] : ['alert.manage', 'tracking.view'], baseId: i.baseId ?? null }))
    return { alert: a, created: true, escalated: false, effects }
  }
}
