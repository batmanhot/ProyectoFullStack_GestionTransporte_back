import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { RequestContext } from '../../common/context/request-context'
import { Errors } from '../../common/errors/app-error'
import { PLAN, TENANT_LIFECYCLE } from '../../common/labels'
import { PrismaService } from '../../database/prisma.service'
import { publicPrincipal, type Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notifications/notification.service'
import { PlatformSettingsReader } from '../platform/platform-settings.reader'
import { blockedDetail, OPERABLE_LIFECYCLES, subscriptionNotice, type SubscriptionNotice } from '../platform/domain/subscription.policy'
import { PasswordHasher } from './password-hasher'
import { PrincipalLoader } from './principal.loader'
import { TokenService } from './token.service'

export interface SessionView {
  accessToken: string
  expiresAt: string
  principal: ReturnType<typeof publicPrincipal>
}

export interface IssuedSession {
  session: SessionView
  refreshToken: string
  refreshExpiresAt: Date
}

/** Reutilizar un refresh ya rotado dentro de esta ventana se trata como carrera benigna (dos pestañas), no como robo. */
const BENIGN_REUSE_MS = 10_000

/**
 * Autenticación (DOC-E-BE §G · ADR-003 · RF-032 · PC-A22).
 * AUTHENTICATION = quién eres. Los permisos (AUTHORIZATION) se resuelven aparte en cada petición.
 */
@Injectable()
export class AuthService {
  /** Hash de relleno para igualar el tiempo de respuesta cuando el slug o el usuario no existen (no revela qué existe). */
  private dummyHash: Promise<string> | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalLoader,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settings: PlatformSettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: { slug?: string; email: string; password: string }): Promise<IssuedSession> {
    const db = this.prisma.system // antes de autenticar no hay tenant en contexto: se resuelve por el slug
    const emailKey = input.email.trim().toLowerCase()
    const slug = input.slug?.trim().toLowerCase() || null
    const invalid = async (tenantId: string | null, userId: string | null) => {
      await this.audit.recordSafe({ kind: 'Seguridad', tenantId, actorName: emailKey, actorUserId: userId, resourceType: 'Sesión', resourceId: slug ?? 'plataforma', action: 'auth.login.failed', result: 'DENEGADO' })
      // Mismo mensaje para slug inexistente, correo inexistente o contraseña errónea: no revela qué existe.
      return Errors.unauthenticated('Correo o contraseña incorrectos.')
    }

    const tenant = slug ? await db.tenant.findUnique({ where: { slug }, include: { subscriptions: { where: { current: true }, take: 1 } } }) : null
    if (slug && !tenant) {
      await this.hasher.verify(input.password, await this.equalizer())
      throw await invalid(null, null)
    }
    const user = await db.user.findFirst({ where: { tenantId: tenant?.id ?? null, emailKey }, include: { roles: true } })
    if (!user) {
      await this.hasher.verify(input.password, await this.equalizer())
      throw await invalid(tenant?.id ?? null, null)
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.hasher.verify(input.password, await this.equalizer()) // mismo costo que un intento normal: no revela cuentas bloqueadas por tiempo
      await this.audit.recordSafe({ kind: 'Seguridad', tenantId: user.tenantId, actorName: emailKey, actorUserId: user.id, resourceType: 'Sesión', resourceId: user.id, action: 'auth.login.locked', result: 'DENEGADO' })
      throw Errors.unauthenticated('Demasiados intentos fallidos. Espere unos minutos antes de volver a intentar.')
    }
    if (!(await this.hasher.verify(input.password, user.passwordHash))) {
      const failed = user.failedLogins + 1
      const lock = failed >= this.config.auth.maxFailedLogins
      await db.user.update({ where: { id: user.id }, data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + this.config.auth.lockMinutes * 60_000) : null } })
      throw await invalid(user.tenantId, user.id)
    }
    if (user.status !== 'ACTIVO') {
      await this.audit.recordSafe({ kind: 'Seguridad', tenantId: user.tenantId, actorName: user.name, actorUserId: user.id, resourceType: 'Sesión', resourceId: user.id, action: 'auth.login.denied', result: 'DENEGADO', after: 'Cuenta no activa' })
      throw Errors.forbidden('Su cuenta está inactiva o bloqueada. Contacte al administrador.')
    }
    let notice: SubscriptionNotice | null = null
    if (tenant) {
      if (!(OPERABLE_LIFECYCLES as readonly string[]).includes(tenant.lifecycle)) {
        await this.audit.recordSafe({ kind: 'Seguridad', tenantId: tenant.id, actorName: user.name, actorUserId: user.id, resourceType: 'Sesión', resourceId: tenant.id, action: 'auth.login.denied', result: 'DENEGADO', after: `Tenant ${TENANT_LIFECYCLE.label(tenant.lifecycle)}` })
        throw Errors.tenantInvalid(tenant.lastChangeReason ?? 'La organización está suspendida. Sus datos se conservan.', { tenantStatus: TENANT_LIFECYCLE.label(tenant.lifecycle), tenantName: tenant.name })
      }
      const sub = tenant.subscriptions[0]
      notice = sub ? subscriptionNotice({ plan: PLAN.label(sub.plan), endsAt: sub.endsAt }, tenant.name, await this.settings.graceDays()) : null
      if (notice?.status === 'Bloqueada') {
        await this.audit.recordSafe({ kind: 'Seguridad', tenantId: tenant.id, actorName: user.name, actorUserId: user.id, resourceType: 'Sesión', resourceId: tenant.id, action: 'auth.login.denied', result: 'DENEGADO', after: 'Suscripción vencida' })
        throw Errors.tenantInvalid(blockedDetail(notice), { subscriptionExpired: true, tenantName: tenant.name })
      }
    }

    const familyId = randomUUID()
    const refresh = this.tokens.newRefreshToken()
    const ctx = RequestContext.get()
    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null } }),
      db.authSession.create({ data: { userId: user.id, tenantId: user.tenantId, familyId, tokenHash: refresh.hash, expiresAt: refresh.expiresAt, ip: ctx?.ip ?? null, userAgent: ctx?.userAgent?.slice(0, 300) ?? null } }),
    ])
    const principal = await this.principals.load(user.id, familyId)
    RequestContext.setPrincipal(principal)
    await this.audit.record({ kind: 'Seguridad', resourceType: 'Sesión', resourceId: user.id, action: 'auth.login', after: 'Login correcto' })
    if (tenant && notice) await this.syncNoticeNotification(tenant.id, notice)
    return { session: await this.sessionOf(principal, familyId), refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt }
  }

  /** Rotación del refresh (ADR-003). Reutilizar un token ya rotado revoca TODA la familia (posible robo). */
  async refresh(presented: string | undefined): Promise<IssuedSession> {
    if (!presented) throw Errors.unauthenticated()
    const db = this.prisma.system
    const row = await db.authSession.findUnique({ where: { tokenHash: TokenServiceHash(presented) } })
    if (!row || row.revokedAt || row.expiresAt <= new Date()) throw Errors.unauthenticated()
    if (row.rotatedAt) {
      if (Date.now() - row.rotatedAt.getTime() > BENIGN_REUSE_MS) {
        await db.authSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'refresh-reuse' } })
        await this.audit.recordSafe({ kind: 'Seguridad', tenantId: row.tenantId, actorName: 'Sistema', actorUserId: row.userId, resourceType: 'Sesión', resourceId: row.userId, action: 'auth.refresh.reuse_detected', result: 'DENEGADO', after: 'Familia de sesión revocada' })
      }
      throw Errors.unauthenticated()
    }
    // El principal valida cuenta, negocio y suscripción ANTES de emitir nada nuevo.
    const principal = await this.principals.load(row.userId, row.familyId)
    const next = this.tokens.newRefreshToken()
    const ctx = RequestContext.get()
    const rotated = await db.authSession.updateMany({ where: { id: row.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } })
    if (rotated.count !== 1) throw Errors.unauthenticated() // otra petición rotó primero
    await db.authSession.create({ data: { userId: row.userId, tenantId: row.tenantId, familyId: row.familyId, tokenHash: next.hash, expiresAt: next.expiresAt, ip: ctx?.ip ?? null, userAgent: ctx?.userAgent?.slice(0, 300) ?? null } })
    RequestContext.setPrincipal(principal)
    return { session: await this.sessionOf(principal, row.familyId), refreshToken: next.token, refreshExpiresAt: next.expiresAt }
  }

  /** Logout seguro: revoca la familia (el access token vigente deja de servir en la siguiente petición). Idempotente. */
  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return
    const db = this.prisma.system
    const row = await db.authSession.findUnique({ where: { tokenHash: TokenServiceHash(presented) } })
    if (!row) return
    await db.authSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'logout' } })
    await this.audit.recordSafe({ kind: 'Seguridad', tenantId: row.tenantId, actorUserId: row.userId, actorName: RequestContext.principal()?.name ?? 'Usuario', resourceType: 'Sesión', resourceId: row.userId, action: 'auth.logout' })
  }

  /** Aviso comercial no intrusivo para el negocio de la sesión (FE-CONTRACT-014). `null` si no requiere atención. */
  async noticeFor(p: Principal): Promise<SubscriptionNotice | null> {
    if (!p.tenantId) return null
    const t = await this.prisma.system.tenant.findUnique({ where: { id: p.tenantId }, include: { subscriptions: { where: { current: true }, take: 1 } } })
    const sub = t?.subscriptions[0]
    if (!t || !sub) return null
    const notice = subscriptionNotice({ plan: PLAN.label(sub.plan), endsAt: sub.endsAt }, t.name, await this.settings.graceDays())
    if (notice) await this.syncNoticeNotification(t.id, notice)
    return notice
  }

  /** Una notificación por fase y por vencimiento: consultar muchas veces no satura la bandeja. */
  private async syncNoticeNotification(tenantId: string, n: SubscriptionNotice): Promise<void> {
    if (n.status === 'Bloqueada') return
    const due = n.endsAt.slice(0, 10)
    const porVencer = n.status === 'Por vencer'
    await this.notifications.notifyNow({
      tenantId,
      kind: porVencer ? 'subscription.expiring' : 'subscription.grace',
      severity: porVencer ? 'MEDIA' : 'ALTA',
      title: porVencer ? 'Suscripción próxima a vencer' : 'Suscripción vencida: período de gracia',
      body: porVencer
        ? `El plan ${n.plan} vence el ${due}. Coordine la renovación para mantener el acceso sin interrupciones.`
        : `El plan ${n.plan} venció el ${due}. Puede seguir operando hasta ${n.accessUntil.slice(0, 10)} mientras se regulariza el pago.`,
      dedupeKey: `subscription.${porVencer ? 'por-vencer' : 'en-gracia'}.${due}`,
    })
  }

  private equalizer(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(`timing-equalizer-${randomUUID()}`)
    return this.dummyHash
  }

  private async sessionOf(principal: Principal, familyId: string): Promise<SessionView> {
    const access = await this.tokens.signAccess(principal.userId, familyId)
    return { accessToken: access.token, expiresAt: access.expiresAt.toISOString(), principal: publicPrincipal(principal) }
  }
}

const TokenServiceHash = (t: string) => TokenService.hash(t)
