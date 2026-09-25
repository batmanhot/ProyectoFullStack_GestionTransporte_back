import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import type { Severity } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { MS_DAY } from '../../common/http/params'
import { IdempotencyService } from '../../common/idempotency/idempotency.service'
import { PrismaService } from '../../database/prisma.service'
import { documentPhase } from '../fleet/domain/eligibility'
import { AlertEngine } from '../monitoring/alert.engine'
import { NotificationService } from '../notifications/notification.service'
import { PlatformGovernanceService } from '../platform/platform-governance.service'
import { PlatformSettingsReader } from '../platform/platform-settings.reader'
import { subscriptionNotice } from '../platform/domain/subscription.policy'
import { JobRunner } from './job-runner'

const fmt = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Jobs de negocio (prompt §20–21). Frecuencias = SUPUESTO TÉCNICO. Todos son IDEMPOTENTES (reglas con `dedupeKey`):
 * reejecutarlos no duplica alertas ni notificaciones.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly runner: JobRunner,
    private readonly prisma: PrismaService,
    private readonly alerts: AlertEngine,
    private readonly notifications: NotificationService,
    private readonly settings: PlatformSettingsReader,
    private readonly governance: PlatformGovernanceService,
    private readonly idem: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * PC-A7 · CTRL-005/023: todo documento vigente «Por vencer» o «Vencido» tiene UNA alerta con responsable. Si empeora (fase o
   * severidad) se escala la misma alerta; renovar el documento la resuelve (FleetService.createDocument).
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'documents.expiry' })
  documentsExpiry() {
    return this.runner.run('documents.expiry', async () => {
      const n = await this.runner.forEachTenant(async (tenantId) => this.syncDocumentAlerts(tenantId))
      return `${n} alerta(s) creadas o escaladas`
    })
  }

  async syncDocumentAlerts(tenantId: string): Promise<number> {
    const db = this.prisma.db
    const now = Date.now()
    const docs = await db.complianceDocument.findMany({ where: { replaced: false, expiresAt: { lte: new Date(now + this.config.ops.docExpiringDays * MS_DAY) } } })
    let changed = 0
    for (const d of docs) {
      const phase = documentPhase(d, now, this.config.ops.docExpiringDays)
      if (phase !== 'Por vencer' && phase !== 'Vencido') continue
      const left = Math.ceil((d.expiresAt.getTime() - now) / MS_DAY)
      const severity: Severity = phase === 'Vencido' ? (d.critical ? 'ALTA' : 'MEDIA') : d.critical && left <= 7 ? 'MEDIA' : 'BAJA'
      // Si ya se gestionó la alerta de esta fase, no se insiste hasta que empeore (clave por documento + fase).
      const handled = await db.alert.findFirst({ where: { documentId: d.id, phase, status: { in: ['RESUELTA', 'CERRADA'] } }, select: { id: true } })
      if (handled) continue
      const owner = await this.owner(d.resourceType)
      const vehicle = d.resourceType === 'VEHICULO' ? await db.vehicle.findFirst({ where: { id: d.resourceId }, select: { id: true, plate: true, baseId: true } }) : null
      const subj = d.resourceType === 'VEHICULO' ? 'el vehículo' : 'el conductor'
      const detail = phase === 'Vencido'
        ? `${d.docType} de ${d.resourceLabel} venció el ${fmt(d.expiresAt)}.${d.critical ? ` Es crítico: ${subj} no puede habilitarse hasta renovarlo.` : ''}`
        : `${d.docType} de ${d.resourceLabel} vence el ${fmt(d.expiresAt)} (en ${left} día(s)).${d.critical ? ' Es crítico: si vence, bloquea la habilitación.' : ''}`
      const r = await this.prisma.tx((tx) =>
        this.alerts.raise(tx, {
          tenantId, kind: 'VENCIMIENTO', severity, detail, dedupeKey: `document:${d.id}`, vehicleId: vehicle?.id ?? null, vehiclePlate: vehicle?.plate ?? null, baseId: vehicle?.baseId ?? null,
          assignee: owner, documentId: d.id, subject: d.resourceLabel, dueAt: d.expiresAt, phase, notifyTitle: phase === 'Vencido' ? 'Documento vencido' : 'Documento por vencer',
        }),
      )
      r.effects.forEach((e) => e())
      if (r.created || r.escalated) changed++
    }
    return changed
  }

  /** Responsable del seguimiento: vehículos → mantenimiento (o flota); conductores → jefe de transporte (dueño de ENT-006). */
  private async owner(type: 'VEHICULO' | 'CONDUCTOR'): Promise<string | null> {
    for (const role of type === 'VEHICULO' ? ['ROL-009', 'ROL-004'] : ['ROL-003']) {
      const u = await this.prisma.db.user.findFirst({ where: { status: 'ACTIVO', roles: { some: { roleId: role } } }, select: { name: true } })
      if (u) return u.name
    }
    return null
  }

  /** EVT-004 · RN-005: viaje en ruta cuyo vehículo con GPS dejó de reportar ⇒ alerta «Sin señal» (nunca se simula una posición). */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'tracking.signal' })
  signalLost() {
    return this.runner.run('tracking.signal', async () => {
      const n = await this.runner.forEachTenant(async (tenantId) => {
        const db = this.prisma.db
        const trips = await db.trip.findMany({ where: { lifecycle: 'EN_RUTA', vehicleId: { not: null } } })
        let raised = 0
        for (const t of trips) {
          const v = await db.vehicle.findFirst({ where: { id: t.vehicleId! }, select: { id: true, plate: true, gpsDeviceId: true } })
          if (!v?.gpsDeviceId) continue // EXC-007: sin GPS se despachó sabiendo que no habría ubicación
          const pos = await db.vehicleLastPosition.findFirst({ where: { vehicleId: v.id } })
          const age = pos ? (Date.now() - pos.sourceTime.getTime()) / 1000 : Infinity
          if (age < this.config.ops.signalLostSeconds) continue
          const r = await this.prisma.tx((tx) =>
            this.alerts.raise(tx, {
              tenantId, kind: 'SIN_SENAL', severity: age > this.config.ops.signalLostSeconds * 3 ? 'ALTA' : 'MEDIA', dedupeKey: `signal:${t.id}`,
              detail: pos ? `${v.plate} sin señal desde ${pos.sourceTime.toISOString()} (${Math.round(age / 60)} min).` : `${v.plate} en ruta sin ninguna posición recibida.`,
              tripId: t.id, tripCode: t.code, vehicleId: v.id, vehiclePlate: v.plate, baseId: t.baseId,
            }),
          )
          r.effects.forEach((e) => e())
          if (r.created || r.escalated) raised++
        }
        return raised
      })
      return `${n} alerta(s) de señal`
    })
  }

  /** CTRL-008 detectivo de atrasos: en ruta con la ETA vigente superada más la tolerancia ⇒ alerta «Retraso». */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'trips.delay' })
  delays() {
    return this.runner.run('trips.delay', async () => {
      const limit = new Date(Date.now() - this.config.ops.delayToleranceMinutes * 60_000)
      const n = await this.runner.forEachTenant(async (tenantId) => {
        const trips = await this.prisma.db.trip.findMany({ where: { lifecycle: 'EN_RUTA', OR: [{ etaUpdated: null, plannedEta: { lt: limit } }, { etaUpdated: { lt: limit } }] } })
        let raised = 0
        for (const t of trips) {
          const late = Math.round((Date.now() - (t.etaUpdated ?? t.plannedEta).getTime()) / 60_000)
          const r = await this.prisma.tx((tx) =>
            this.alerts.raise(tx, {
              tenantId, kind: 'RETRASO', severity: late > 120 ? 'ALTA' : 'MEDIA', dedupeKey: `delay:${t.id}`, detail: `${t.code} (${t.routeName}) lleva ${late} min de retraso sobre la ETA.`,
              tripId: t.id, tripCode: t.code, vehicleId: t.vehicleId, vehiclePlate: t.vehiclePlate, baseId: t.baseId,
            }),
          )
          r.effects.forEach((e) => e())
          if (r.created || r.escalated) raised++
        }
        return raised
      })
      return `${n} alerta(s) de retraso`
    })
  }

  /** Suscripciones (prompt §16): aviso previo y de gracia al negocio (una notificación por fase y vencimiento). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'subscriptions.notices' })
  subscriptions() {
    return this.runner.run('subscriptions.notices', async () => {
      const grace = await this.settings.graceDays()
      const tenants = await this.prisma.system.tenant.findMany({ where: { lifecycle: { in: ['ACTIVO', 'REACTIVADO'] } }, include: { subscriptions: { where: { current: true } } } })
      let sent = 0
      for (const t of tenants) {
        const s = t.subscriptions[0]
        const n = s ? subscriptionNotice({ plan: s.plan, endsAt: s.endsAt }, t.name, grace) : null
        if (!n || n.status === 'Bloqueada') continue
        const porVencer = n.status === 'Por vencer'
        await this.notifications.notifyNow({
          tenantId: t.id, kind: porVencer ? 'subscription.expiring' : 'subscription.grace', severity: porVencer ? 'MEDIA' : 'ALTA',
          title: porVencer ? 'Suscripción próxima a vencer' : 'Suscripción vencida: período de gracia',
          body: porVencer ? `El plan vence el ${n.endsAt.slice(0, 10)}. Coordine la renovación.` : `El plan venció el ${n.endsAt.slice(0, 10)}. Puede operar hasta ${n.accessUntil.slice(0, 10)}.`,
          dedupeKey: `subscription.${porVencer ? 'por-vencer' : 'en-gracia'}.${n.endsAt.slice(0, 10)}`,
        })
        sent++
      }
      return `${sent} negocio(s) con aviso`
    })
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'support.expiry' })
  supportExpiry() {
    return this.runner.run('support.expiry', async () => `${await this.governance.expireSupport()} sesión(es) expiradas`)
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'idempotency.purge' })
  purge() {
    return this.runner.run('idempotency.purge', async () => `${await this.idem.purgeExpired()} clave(s) vencidas eliminadas`)
  }
}
