import { Injectable } from '@nestjs/common'
import type { Prisma, SupportSession, Tenant, User, UserRole } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { PLAN, SUPPORT_STATUS, TENANT_LIFECYCLE, USER_STATUS } from '../../common/labels'
import { cutoff, pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, iso } from '../../common/http/params'
import { MetricsService } from '../../common/observability/metrics.service'
import { PrismaService } from '../../database/prisma.service'
import { isPermission, isRoleId, ROLES, type Permission } from '../access/domain/catalog'
import type { Principal } from '../access/domain/principal'
import { RoleMatrixService } from '../access/role-matrix.service'
import { temporaryPassword } from '../access/access.service'
import { AuditService } from '../audit/audit.service'
import { PasswordHasher } from '../auth/password-hasher'
import { RealtimeGateway } from '../realtime/realtime.gateway'
import { subscriptionNotice } from './domain/subscription.policy'
import { PlatformSettingsReader } from './platform-settings.reader'
import { PlatformTenantsService } from './platform-tenants.service'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_DELEGATES = 2
type UserWithRoles = User & { roles: UserRole[] }

const adminView = (u: User) => ({ id: u.id, name: u.name, email: u.email, nativo: u.isNative, status: USER_STATUS.label(u.status), lastLoginAt: iso(u.lastLoginAt) })
const supportView = (s: SupportSession) => ({
  id: s.id, tenantId: s.tenantId, tenantName: s.tenantName, caseRef: s.caseRef, reason: s.reason, scope: s.scope, requestedBy: s.requestedBy,
  startedAt: s.startedAt.toISOString(), expiresAt: s.expiresAt.toISOString(), status: SUPPORT_STATUS.label(s.status), revokedAt: iso(s.revokedAt),
})

/**
 * Gobierno de plataforma (PC-A1 Fases 1–4 · prompt §14/§19). El backend ENFORZA — no la UI —:
 *  - SuperAdmin Nativo único; hasta 2 Delegados; solo el Nativo crea/edita/activa Delegados; nadie modifica al Nativo.
 *  - Admin Owner (ROL-015) y Admin Tenant (ROL-002): un titular activo por cupo, asignados solo por el SuperAdmin.
 *  - Soporte (SOD-003): caso + motivo + alcance + ≤ 8 h + revocable; el diagnóstico es agregado, sin contenido de negocio.
 */
@Injectable()
export class PlatformGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly matrix: RoleMatrixService,
    private readonly settings: PlatformSettingsReader,
    private readonly tenants: PlatformTenantsService,
    private readonly metrics: MetricsService,
    private readonly gateway: RealtimeGateway,
  ) {}

  private get db() {
    return this.prisma.system
  }

  /* ───────────── SuperAdmins ───────────── */

  async listAdmins() {
    const rows = await this.db.user.findMany({ where: { tenantId: null, roles: { some: { roleId: 'ROL-001' } } }, orderBy: [{ isNative: 'desc' }, { name: 'asc' }] })
    return rows.map(adminView)
  }

  private requireNative(p: Principal, what: string) {
    if (!p.isNative) throw Errors.forbidden(`Solo el SuperAdmin nativo puede ${what}.`, { rule: 'PC-A1' })
  }

  async createAdmin(p: Principal, i: { name: string; email: string }) {
    this.requireNative(p, 'crear otros SuperAdmin (delegados)')
    const errs = new FieldErrors()
    errs.when(clean(i.name).length < 3, 'name', 'Ingrese el nombre.')
    errs.when(!EMAIL_RE.test(clean(i.email)), 'email', 'Ingrese un correo válido.')
    errs.throwIfAny()
    const emailKey = clean(i.email).toLowerCase()
    const temp = temporaryPassword()
    const hash = await this.hasher.hash(temp)
    const u = await this.prisma.systemTx(async (tx) => {
      const delegates = await tx.user.count({ where: { tenantId: null, isNative: false, roles: { some: { roleId: 'ROL-001' } } } })
      if (delegates >= MAX_DELEGATES) throw Errors.conflict('Cupo completo', `Ya existen ${MAX_DELEGATES} SuperAdmin delegados. Desactive uno antes de crear otro.`)
      if (await tx.user.findFirst({ where: { tenantId: null, emailKey }, select: { id: true } })) throw Errors.field('email', 'Ya existe una cuenta de plataforma con ese correo.')
      const nu = await tx.user.create({
        data: { tenantId: null, name: clean(i.name), email: clean(i.email), emailKey, passwordHash: hash, roles: { create: [{ roleId: 'ROL-001' }] }, scopes: { create: [{ type: 'PLATFORM', label: 'Plataforma' }] } },
      })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'SuperAdmin', resourceId: nu.email, action: 'platform_admin.create', after: 'Delegado' }, tx)
      return nu
    })
    return { ...adminView(u), temporaryPassword: temp }
  }

  private async targetAdmin(id: string) {
    const t = await this.db.user.findFirst({ where: { id, tenantId: null, roles: { some: { roleId: 'ROL-001' } } } })
    if (!t) throw Errors.notFound('La cuenta no existe.')
    if (t.isNative) throw Errors.forbidden('La cuenta del SuperAdmin nativo no puede modificarse desde aquí.', { rule: 'PC-A1' })
    return t
  }

  async updateAdmin(p: Principal, id: string, i: { name: string; email: string }) {
    this.requireNative(p, 'editar SuperAdmins delegados')
    const t = await this.targetAdmin(id)
    const errs = new FieldErrors()
    errs.when(clean(i.name).length < 3, 'name', 'Ingrese el nombre.')
    errs.when(!EMAIL_RE.test(clean(i.email)), 'email', 'Ingrese un correo válido.')
    errs.throwIfAny()
    const emailKey = clean(i.email).toLowerCase()
    if (await this.db.user.findFirst({ where: { tenantId: null, emailKey, id: { not: id } }, select: { id: true } })) throw Errors.field('email', 'Ya existe una cuenta de plataforma con ese correo.')
    const u = await this.db.user.update({ where: { id }, data: { name: clean(i.name), email: clean(i.email), emailKey } })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'SuperAdmin', resourceId: u.email, action: 'platform_admin.edit', before: `${t.name} · ${t.email}`, after: `${u.name} · ${u.email}` })
    return adminView(u)
  }

  async setAdminActive(p: Principal, id: string, active: boolean, reason?: string) {
    this.requireNative(p, 'activar o desactivar cuentas de SuperAdmin')
    await this.targetAdmin(id)
    const u = await this.prisma.systemTx(async (tx) => {
      const nu = await tx.user.update({ where: { id }, data: { status: active ? 'ACTIVO' : 'INACTIVO' } })
      if (!active) await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'platform_admin.deactivated' } })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'SuperAdmin', resourceId: nu.email, action: 'platform_admin.update', after: USER_STATUS.label(nu.status), reason: clean(reason) || null }, tx)
      return nu
    })
    return adminView(u)
  }

  /* ───────────── cupos de administración de negocio ───────────── */

  private slot(t: Tenant, role: 'ROL-002' | 'ROL-015', users: UserWithRoles[]) {
    const holders = users.filter((u) => u.tenantId === t.id && u.roles.some((r) => r.roleId === role))
    const h = holders.find((u) => u.status === 'ACTIVO') ?? holders[0]
    return {
      tenantId: t.id, tenantName: t.name, tenantLifecycle: TENANT_LIFECYCLE.label(t.lifecycle), role, roleLabel: ROLES[role].name,
      user: h ? { id: h.id, name: h.name, email: h.email, status: USER_STATUS.label(h.status), lastLoginAt: iso(h.lastLoginAt) } : null,
    }
  }

  private async allSlots() {
    const [tenants, users] = await Promise.all([
      this.db.tenant.findMany({ orderBy: { name: 'asc' } }),
      this.db.user.findMany({ where: { tenantId: { not: null }, roles: { some: { roleId: { in: ['ROL-002', 'ROL-015'] } } } }, include: { roles: true } }),
    ])
    return tenants.flatMap((t) => [this.slot(t, 'ROL-002', users), this.slot(t, 'ROL-015', users)])
  }

  async listSlots(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['tenantName', 'role'], filters: ['role', 'tenantId', 'filled'], defaultSort: { field: 'tenantName', dir: 'asc' } })
    return pageInMemory(await this.allSlots(), q, {
      search: (s) => `${s.tenantName} ${s.user?.name ?? ''} ${s.user?.email ?? ''}`,
      filters: { role: (s, v) => s.role === v, tenantId: (s, v) => s.tenantId === v, filled: (s, v) => (v === '1' ? !!s.user : !s.user) },
      facets: { role: (s) => s.role, filled: (s) => (s.user ? '1' : '0') },
      sort: { tenantName: (s) => s.tenantName, role: (s) => s.role },
    })
  }

  async assignTenantAdmin(tenantId: string, i: { role: 'ROL-002' | 'ROL-015'; name: string; email: string }) {
    const t = await this.tenants.one(tenantId)
    const errs = new FieldErrors()
    errs.when(clean(i.name).length < 3, 'name', 'Ingrese el nombre.')
    errs.when(!EMAIL_RE.test(clean(i.email)), 'email', 'Ingrese un correo válido.')
    errs.throwIfAny()
    const emailKey = clean(i.email).toLowerCase()
    const temp = temporaryPassword()
    const hash = await this.hasher.hash(temp)
    await this.prisma.systemTx(async (tx) => {
      const holder = await tx.user.findFirst({ where: { tenantId, status: 'ACTIVO', roles: { some: { roleId: i.role } } } })
      if (holder) throw Errors.conflict('Cupo ocupado', `Ya hay un(a) ${ROLES[i.role].name} activo(a) en este negocio (${holder.name}). Desactívelo antes de asignar uno nuevo.`)
      if (await tx.user.findFirst({ where: { tenantId, emailKey }, select: { id: true } })) throw Errors.field('email', 'Ya existe un usuario con ese correo en este negocio.')
      const u = await tx.user.create({
        data: { tenantId, name: clean(i.name), email: clean(i.email), emailKey, passwordHash: hash, roles: { create: [{ roleId: i.role, tenantId }] }, scopes: { create: [{ tenantId, type: 'TENANT', refId: tenantId, label: t.name }] } },
      })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Administrador de negocio', resourceId: `${t.name} · ${u.email}`, action: 'tenant_admin.assign', after: ROLES[i.role].name }, tx)
    })
    const users = await this.db.user.findMany({ where: { tenantId }, include: { roles: true } })
    return { ...this.slot(t, i.role, users), temporaryPassword: temp }
  }

  async setTenantAdminActive(userId: string, active: boolean, reason?: string) {
    const u = await this.db.user.findFirst({ where: { id: userId, tenantId: { not: null }, roles: { some: { roleId: { in: ['ROL-002', 'ROL-015'] } } } }, include: { roles: true } })
    if (!u || !u.tenantId) throw Errors.notFound('El administrador no existe.')
    const t = await this.tenants.one(u.tenantId)
    const role = u.roles.some((r) => r.roleId === 'ROL-002') ? 'ROL-002' : 'ROL-015'
    await this.prisma.systemTx(async (tx) => {
      if (active) {
        const other = await tx.user.findFirst({ where: { tenantId: u.tenantId, status: 'ACTIVO', id: { not: u.id }, roles: { some: { roleId: role } } } })
        if (other) throw Errors.conflict('Cupo ocupado', `El cupo ya tiene un titular activo (${other.name}).`)
      }
      await tx.user.update({ where: { id: u.id }, data: { status: active ? 'ACTIVO' : 'INACTIVO' } })
      if (!active) await tx.authSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'tenant_admin.deactivated' } })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Administrador de negocio', resourceId: `${t.name} · ${u.email}`, action: 'tenant_admin.update', after: active ? 'Activo' : 'Inactivo', reason: clean(reason) || null }, tx)
    })
    const users = await this.db.user.findMany({ where: { tenantId: u.tenantId }, include: { roles: true } })
    return this.slot(t, role, users)
  }

  /* ───────────── soporte (SOD-003) ───────────── */

  async expireSupport() {
    const expired = await this.db.supportSession.findMany({ where: { status: 'ACTIVA', expiresAt: { lte: new Date() } } })
    for (const s of expired) {
      await this.db.$transaction([
        this.db.supportSession.update({ where: { id: s.id }, data: { status: 'EXPIRADA' } }),
        this.db.supportInteraction.create({ data: { sessionId: s.id, actor: 'Sistema', action: 'Sesión expirada', sessionStatus: 'EXPIRADA' } }),
      ])
    }
    return expired.length
  }

  async listSupport() {
    await this.expireSupport()
    return (await this.db.supportSession.findMany({ orderBy: { startedAt: 'desc' } })).map(supportView)
  }

  async listInteractions() {
    await this.expireSupport()
    const rows = await this.db.supportInteraction.findMany({ include: { session: true }, orderBy: { at: 'desc' }, take: 500 })
    return rows.map((r) => ({ id: r.id, sessionId: r.sessionId, tenantName: r.session.tenantName, caseRef: r.session.caseRef, at: r.at.toISOString(), actor: r.actor, action: r.action, scope: r.session.scope, sessionStatus: SUPPORT_STATUS.label(r.sessionStatus) }))
  }

  async openSupport(p: Principal, i: { tenantId: string; caseRef: string; reason: string; scope: string; hours: number }) {
    await this.expireSupport()
    const errs = new FieldErrors()
    const t = await this.db.tenant.findUnique({ where: { id: i.tenantId } })
    if (!t) errs.add('tenantId', 'Seleccione un negocio existente.')
    else errs.when(t.lifecycle === 'CERRADO', 'tenantId', 'No se puede abrir soporte para un negocio cerrado.')
    errs.when(clean(i.caseRef).length < 3, 'caseRef', 'Ingrese el caso de soporte.')
    errs.when(clean(i.reason).length < 10, 'reason', 'El motivo es obligatorio (mín. 10 caracteres).')
    errs.when(!clean(i.scope), 'scope', 'Seleccione el alcance del acceso.')
    errs.when(!Number.isInteger(i.hours) || i.hours < 1 || i.hours > 8, 'hours', 'La duración debe estar entre 1 y 8 horas.')
    errs.throwIfAny()
    const s = await this.prisma.systemTx(async (tx) => {
      const now = new Date()
      const ns = await tx.supportSession.create({
        data: { tenantId: t!.id, tenantName: t!.name, caseRef: clean(i.caseRef), reason: clean(i.reason), scope: clean(i.scope), requestedBy: p.name, requestedById: p.userId, startedAt: now, expiresAt: new Date(now.getTime() + i.hours * 3_600_000) },
      })
      await tx.supportInteraction.create({ data: { sessionId: ns.id, actor: p.name, action: 'Sesión abierta', sessionStatus: 'ACTIVA' } })
      // Se audita en la plataforma Y en el negocio afectado: el cliente ve que hubo un acceso de soporte a su tenant.
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Acceso de soporte', resourceId: `${ns.tenantName} · ${ns.caseRef}`, action: 'support.open', reason: ns.reason, after: `${i.hours} h · ${ns.scope}` }, tx)
      await this.audit.record({ kind: 'Seguridad', tenantId: ns.tenantId, resourceType: 'Acceso de soporte', resourceId: ns.caseRef, action: 'support.open', reason: ns.reason, after: `${i.hours} h · ${ns.scope}` }, tx)
      return ns
    })
    return supportView(s)
  }

  async revokeSupport(p: Principal, id: string) {
    await this.expireSupport()
    const s = await this.db.supportSession.findUnique({ where: { id } })
    if (!s) throw Errors.notFound('Sesión de soporte inexistente.')
    if (s.status !== 'ACTIVA') throw Errors.conflict('Acceso no vigente', `La sesión ya está ${SUPPORT_STATUS.label(s.status).toLowerCase()}.`)
    const next = await this.prisma.systemTx(async (tx) => {
      const ns = await tx.supportSession.update({ where: { id }, data: { status: 'REVOCADA', revokedAt: new Date() } })
      await tx.supportInteraction.create({ data: { sessionId: id, actor: p.name, action: 'Sesión revocada', sessionStatus: 'REVOCADA' } })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Acceso de soporte', resourceId: `${s.tenantName} · ${s.caseRef}`, action: 'support.revoke', after: 'Revocada' }, tx)
      return ns
    })
    return supportView(next)
  }

  async recordExit(p: Principal, id: string) {
    await this.expireSupport()
    const s = await this.db.supportSession.findUnique({ where: { id } })
    if (!s) throw Errors.notFound('Sesión de soporte inexistente.')
    if (s.status !== 'ACTIVA') return
    await this.db.supportInteraction.create({ data: { sessionId: id, actor: p.name, action: 'Modo soporte cerrado', sessionStatus: 'ACTIVA' } })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Acceso de soporte', resourceId: `${s.tenantName} · ${s.caseRef}`, action: 'support.exit', after: s.scope })
  }

  /** Diagnóstico mínimo (solo contadores y salud técnica, sin identificadores ni contenido) y solo con sesión ACTIVA. */
  async diagnostics(p: Principal, id: string) {
    await this.expireSupport()
    const s = await this.db.supportSession.findUnique({ where: { id } })
    if (!s) throw Errors.notFound('Sesión de soporte inexistente.')
    if (s.status !== 'ACTIVA') throw Errors.forbidden(`El acceso de soporte no está vigente (sesión ${SUPPORT_STATUS.label(s.status).toLowerCase()}).`)
    const t = await this.tenants.one(s.tenantId)
    const tid = t.id
    const [vehicles, drivers, routes, activeTrips, openAlerts, openIncidents] = await Promise.all([
      this.db.vehicle.count({ where: { tenantId: tid } }),
      this.db.driver.count({ where: { tenantId: tid } }),
      this.db.route.count({ where: { tenantId: tid } }),
      this.db.trip.count({ where: { tenantId: tid, lifecycle: { in: ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO'] } } }),
      this.db.alert.count({ where: { tenantId: tid, status: { notIn: ['RESUELTA', 'CERRADA'] } } }),
      this.db.incident.count({ where: { tenantId: tid, status: { notIn: ['RESUELTA', 'CERRADA'] } } }),
    ])
    const health = (await this.tenantHealth()).find((h) => h.tenantId === tid)
    await this.db.supportInteraction.create({ data: { sessionId: id, actor: p.name, action: 'Diagnóstico consultado', sessionStatus: 'ACTIVA' } })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Acceso de soporte', resourceId: `${s.tenantName} · ${s.caseRef}`, action: 'support.diagnostics.view', after: s.scope })
    await this.audit.record({ kind: 'Seguridad', tenantId: tid, resourceType: 'Acceso de soporte', resourceId: s.caseRef, action: 'support.diagnostics.view', after: s.scope })
    const { tenantId: _t, tenantName: _n, ...h } = health ?? { tenantId: tid, tenantName: t.name, apiErrorRatePct: 0, ingestionLagSec: null, failedJobs: 0, outboxBacklog: 0, wsConnections: 0, integrationsFailing: 0, status: 'Operativo' as const }
    return { session: supportView(s), tenantLifecycle: TENANT_LIFECYCLE.label(t.lifecycle), cutoffAt: cutoff(), health: h, operations: { vehicles, drivers, routes, activeTrips, openAlerts, openIncidents } }
  }

  /* ───────────── salud, telemetría, alertas y panel ───────────── */

  async tenantHealth() {
    const tenants = await this.db.tenant.findMany({ where: { lifecycle: { in: ['ACTIVO', 'REACTIVADO', 'SUSPENDIDO'] } } })
    const ws = this.gateway.connectionsByTenant()
    const [lag, pending, failing] = await Promise.all([
      this.db.telemetryEvent.groupBy({ by: ['tenantId'], _max: { receivedAt: true } }),
      this.db.notificationDelivery.groupBy({ by: ['notificationId'], where: { status: 'PENDIENTE' }, _count: { _all: true } }).then(async (rows) => (rows.length ? this.db.notification.findMany({ where: { id: { in: rows.map((r) => r.notificationId) } }, select: { tenantId: true } }) : [])),
      this.db.notificationDelivery.findMany({ where: { status: 'FALLIDA' }, select: { notification: { select: { tenantId: true } } } }),
    ])
    const failedJobs = await this.db.jobRun.count({ where: { status: 'FAILED', startedAt: { gte: new Date(Date.now() - 86_400_000) } } })
    return tenants.map((t) => {
      const active = t.lifecycle !== 'SUSPENDIDO'
      const last = lag.find((l) => l.tenantId === t.id)?._max.receivedAt ?? null
      const integrationsFailing = failing.filter((f) => f.notification.tenantId === t.id).length
      const apiErrorRatePct = this.metrics.tenantErrorRate(t.id)
      // Umbrales de estado: SUPUESTO TÉCNICO (DOC-I-OPS fijará SLO).
      const status: 'Operativo' | 'Degradado' | 'Crítico' = !active ? 'Degradado' : apiErrorRatePct > 5 || integrationsFailing > 3 ? 'Crítico' : apiErrorRatePct > 1 || integrationsFailing > 0 ? 'Degradado' : 'Operativo'
      return {
        tenantId: t.id, tenantName: t.name, apiErrorRatePct, ingestionLagSec: last ? Math.round((Date.now() - last.getTime()) / 1000) : null, failedJobs,
        outboxBacklog: pending.filter((x) => x.tenantId === t.id).length, wsConnections: ws.get(t.id) ?? 0, integrationsFailing, status,
      }
    })
  }

  async health() {
    const items = await this.tenantHealth()
    const hourAgo = new Date(Date.now() - 3_600_000)
    const [inTransit, ready, atDest, risky, openAlerts, critical, openInc, emergencies, messages, jobs] = await Promise.all([
      this.db.trip.count({ where: { lifecycle: 'EN_RUTA' } }),
      this.db.trip.count({ where: { lifecycle: 'LISTO_PARA_SALIDA' } }),
      this.db.trip.count({ where: { lifecycle: 'EN_DESTINO' } }),
      this.db.alert.findMany({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] }, tripId: { not: null } }, select: { tripId: true }, distinct: ['tripId'] }),
      this.db.alert.count({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] } } }),
      this.db.alert.count({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] }, severity: 'CRITICA' } }),
      this.db.incident.count({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] } } }),
      this.db.incident.count({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] }, emergency: true } }),
      this.db.dispatchMessage.count({ where: { receivedAt: { gte: hourAgo } } }),
      this.db.jobRun.findMany({ where: { startedAt: { gte: hourAgo } }, orderBy: { startedAt: 'desc' }, take: 50 }),
    ])
    const m = this.metrics.summary()
    const dbUp = await this.prisma.ping()
    const failedJobs = jobs.filter((j) => j.status === 'FAILED').length
    const status = (bad: boolean, warn = false) => (bad ? ('Crítico' as const) : warn ? ('Degradado' as const) : ('Operativo' as const))
    return {
      items,
      cutoffAt: cutoff(),
      // Sin mecanismo de detección de accesos cruzados confirmados más allá de los rechazos: se informa 0 (KPI-012, meta propuesta 0).
      isolationIncidents: 0,
      operational: { trips: { inTransit, readyToDepart: ready, atDestination: atDest, atRisk: risky.length }, alerts: { open: openAlerts, critical }, incidents: { open: openInc, emergencies }, messagesLastHour: messages },
      telemetry: {
        requestsPerMinute: m.requestsPerMinute, averageLatencyMs: m.averageLatencyMs, p95LatencyMs: m.p95LatencyMs, errorRatePct: m.errorRatePct,
        activeUsersLast5m: m.activeUsersLast5m, liveConnections: this.gateway.total, requestTrend: m.requestTrend,
        services: [
          { id: 'platform-api', name: 'API', category: 'API' as const, status: status(m.errorRatePct > 5, m.errorRatePct > 1), latencyMs: m.averageLatencyMs, errorRatePct: m.errorRatePct, requestsPerMinute: m.requestsPerMinute, availabilityPct: 100 },
          { id: 'realtime', name: 'Canal en tiempo real', category: 'Tiempo real' as const, status: 'Operativo' as const, latencyMs: null, errorRatePct: 0, requestsPerMinute: null, availabilityPct: 100 },
          { id: 'database', name: 'Base de datos', category: 'Datos' as const, status: status(!dbUp), latencyMs: null, errorRatePct: dbUp ? 0 : 100, requestsPerMinute: null, availabilityPct: dbUp ? 100 : 0 },
          { id: 'jobs', name: 'Procesos programados', category: 'Procesamiento' as const, status: status(false, failedJobs > 0), latencyMs: null, errorRatePct: jobs.length ? Math.round((failedJobs / jobs.length) * 1000) / 10 : 0, requestsPerMinute: null, availabilityPct: 100 },
        ],
        recentRequests: m.recent.map((r, i) => ({ id: `rq-${i}`, method: (['GET', 'POST', 'PATCH'].includes(r.method) ? r.method : 'GET') as 'GET' | 'POST' | 'PATCH', route: r.route, status: r.status, latencyMs: Math.round(r.latencyMs), at: new Date(r.at).toISOString() })),
        incidents: jobs.filter((j) => j.status === 'FAILED').slice(0, 5).map((j) => ({ id: j.id, service: 'Procesos programados', category: j.job, status: 'Abierto' as const, startedAt: j.startedAt.toISOString() })),
      },
    }
  }

  /** Centro de alertas de plataforma: señales recalculadas + estado de gestión persistido (silenciada / resuelta). */
  async alertCenter() {
    type Signal = { id: string; severity: 'Crítica' | 'Alta' | 'Media' | 'Informativa'; category: 'Respaldo' | 'Vencimiento' | 'Límite de plan' | 'Entrega' | 'Configuración'; status: 'Activa' | 'Silenciada' | 'Resuelta'; title: string; detail: string; actionHint: string; tenantName: string | null; occurredAt: string; changedAt: string | null }
    const signals: Signal[] = []
    const lastBackup = await this.db.backupRecord.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!lastBackup || Date.now() - lastBackup.createdAt.getTime() > 26 * 3_600_000) {
      signals.push({
        id: 'backup-overdue', severity: 'Alta', category: 'Respaldo', status: 'Activa',
        title: lastBackup ? 'Sin respaldo reciente de negocio' : 'Respaldos por negocio no configurados',
        detail: 'El respaldo y la restauración verificada dependen de la estrategia de DOC-I-OPS (pendiente).', actionHint: 'Definir la política de respaldo, retención y prueba de restauración (DOC-I-OPS).',
        tenantName: null, occurredAt: (lastBackup?.createdAt ?? new Date()).toISOString(), changedAt: null,
      })
    }
    const grace = await this.settings.graceDays()
    const tenants = await this.db.tenant.findMany({ where: { lifecycle: { in: ['ACTIVO', 'REACTIVADO'] } }, include: { subscriptions: { where: { current: true } } } })
    for (const t of tenants) {
      const sub = t.subscriptions[0]
      const n = sub ? subscriptionNotice({ plan: PLAN.label(sub.plan), endsAt: sub.endsAt }, t.name, grace) : null
      if (!n) continue
      const blocked = n.status === 'Bloqueada'
      const inGrace = n.status === 'En gracia'
      signals.push({
        id: `subscription-${t.id}`, severity: blocked ? 'Crítica' : inGrace ? 'Alta' : 'Media', category: 'Vencimiento', status: 'Activa',
        title: blocked ? 'Suscripción bloqueada' : inGrace ? 'Suscripción en período de gracia' : `Plan vence el ${n.endsAt.slice(0, 10)}`,
        detail: blocked ? `${t.name} superó su período de gracia: el acceso está restringido (los datos se conservan).` : inGrace ? `${t.name} venció el ${n.endsAt.slice(0, 10)}; conserva acceso hasta ${n.accessUntil.slice(0, 10)}.` : `${t.name} tiene el plan ${n.plan} vigente hasta ${n.endsAt.slice(0, 10)}.`,
        actionHint: blocked ? 'Renueve la suscripción para reactivar los accesos.' : 'Coordine la renovación con el contacto administrativo del negocio.', tenantName: t.name, occurredAt: n.endsAt, changedAt: null,
      })
    }
    for (const h of await this.tenantHealth()) {
      if (h.integrationsFailing > 0) signals.push({ id: `delivery-${h.tenantId}`, severity: 'Alta', category: 'Entrega', status: 'Activa', title: 'Entregas de notificación fallidas', detail: `${h.tenantName} registra ${h.integrationsFailing} entrega(s) fallida(s).`, actionHint: 'Revise el canal de notificación configurado (DOC-F-INT).', tenantName: h.tenantName, occurredAt: new Date().toISOString(), changedAt: null })
    }
    const states = await this.db.platformAlertState.findMany()
    const alerts = signals.map((s) => {
      const st = states.find((x) => x.signalId === s.id)
      return st ? { ...s, status: st.status as Signal['status'], changedAt: st.changedAt.toISOString() } : s
    })
    for (const st of states) if (!alerts.some((a) => a.id === st.signalId)) alerts.push({ ...(st.snapshot as unknown as Signal), status: st.status as Signal['status'], changedAt: st.changedAt.toISOString() })
    const order = { Crítica: 0, Alta: 1, Media: 2, Informativa: 3 }
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || b.occurredAt.localeCompare(a.occurredAt))
    return {
      cutoffAt: cutoff(), alerts,
      rules: [
        { id: 'rule-backup', label: 'Respaldo atrasado', description: 'Avisa cuando no hay una copia verificable reciente (26 h).', trigger: 'Más de 26 h sin respaldo', enabled: true },
        { id: 'rule-subscription', label: 'Vigencia comercial', description: 'Advierte antes del vencimiento y durante el período de gracia.', trigger: 'Ventana de aviso o gracia', enabled: true },
        { id: 'rule-delivery', label: 'Entregas e integración', description: 'Informa entregas de notificación fallidas.', trigger: 'Entrega fallida', enabled: true },
      ],
      deliveriesFailing: alerts.filter((a) => a.category === 'Entrega' && a.status === 'Activa').length,
    }
  }

  async setAlertStatus(p: Principal, id: string, status: 'Silenciada' | 'Resuelta') {
    const current = (await this.alertCenter()).alerts.find((a) => a.id === id)
    if (!current) throw Errors.notFound('La señal ya no está activa o no existe.')
    const snapshot = { ...current, status } as unknown as Prisma.InputJsonValue
    await this.db.platformAlertState.upsert({ where: { signalId: id }, create: { signalId: id, status, title: current.title, snapshot, changedAt: new Date(), changedBy: p.name }, update: { status, snapshot, changedAt: new Date(), changedBy: p.name } })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Alerta de plataforma', resourceId: current.title, action: `platform_alert.${status === 'Resuelta' ? 'resolve' : 'silence'}`, after: status })
    return this.alertCenter()
  }

  async recalculate() {
    const r = await this.alertCenter()
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Centro de alertas', resourceId: 'Plataforma', action: 'platform_alerts.recalculate', after: `${r.alerts.filter((a) => a.status === 'Activa').length} alerta(s) activa(s)` })
    return r
  }

  async overview() {
    await this.expireSupport()
    const [tenants, slots, admins, health, sessions] = await Promise.all([
      this.db.tenant.findMany({ orderBy: { createdAt: 'desc' }, include: { subscriptions: { where: { current: true } }, deployment: true } }),
      this.allSlots(),
      this.db.user.findMany({ where: { tenantId: null, roles: { some: { roleId: 'ROL-001' } } } }),
      this.tenantHealth(),
      this.db.supportSession.findMany({ where: { status: 'ACTIVA' }, orderBy: { startedAt: 'desc' } }),
    ])
    const vacant = slots.filter((s) => !s.user)
    const lifecycles = ['BORRADOR', 'CONFIGURADO', 'ACTIVO', 'SUSPENDIDO', 'REACTIVADO', 'CERRADO'] as const
    const recent = await Promise.all(tenants.slice(0, 6).map((t) => this.tenants.viewById(t.id)))
    return {
      cutoffAt: cutoff(),
      tenants: { total: tenants.length, byLifecycle: lifecycles.map((l) => ({ lifecycle: TENANT_LIFECYCLE.label(l), count: tenants.filter((t) => t.lifecycle === l).length })).filter((x) => x.count > 0) },
      health: { operational: health.filter((h) => h.status === 'Operativo').length, degraded: health.filter((h) => h.status !== 'Operativo').length },
      admins: { platformActive: admins.filter((a) => a.status === 'ACTIVO').length, platformNative: admins.filter((a) => a.isNative).length, filledSlots: slots.length - vacant.length, vacantSlots: vacant.length, totalSlots: slots.length },
      support: { active: sessions.length },
      vacantSlots: vacant.slice(0, 8),
      recentTenants: recent,
      recentSupportSessions: sessions.slice(0, 6).map(supportView),
    }
  }

  /* ───────────── respaldos: PENDIENTES de DOC-I-OPS ───────────── */

  async listBackups(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['createdAt', 'tenantName'], filters: ['tenantId'], defaultSort: { field: 'createdAt', dir: 'desc' } })
    const rows = await this.db.backupRecord.findMany({ orderBy: { createdAt: 'desc' } })
    const items = rows.map((b) => ({ id: b.id, tenantId: b.tenantId, tenantName: b.tenantName, createdAt: b.createdAt.toISOString(), createdBy: b.createdBy, sizeApproxKb: b.sizeApproxKb, lastRestoredAt: iso(b.lastRestoredAt) }))
    return pageInMemory(items, q, { filters: { tenantId: (b, v) => b.tenantId === v }, facets: { tenantId: (b) => b.tenantId }, sort: { createdAt: (b) => b.createdAt, tenantName: (b) => b.tenantName } })
  }

  backupUnavailable(): never {
    // No se inventa infraestructura (prompt §2): el respaldo/restauración por negocio exige la estrategia de DOC-I-OPS
    // (almacenamiento cifrado, retención, prueba de restauración y exclusión de identidad/auditoría, ver PC-A1 F2).
    throw Errors.external('Los respaldos por negocio se habilitan cuando DOC-I-OPS defina almacenamiento, retención y prueba de restauración. Ningún dato se modificó.')
  }

  /* ───────────── roles y ajustes ───────────── */

  async roleMatrix() {
    return this.matrix.matrix()
  }

  async updateRole(role: string, permissions: string[]) {
    if (!isRoleId(role)) throw Errors.notFound('Rol inexistente.')
    if (role === 'ROL-001') throw Errors.forbidden('El rol de gobierno de la plataforma (SuperAdmin) no se personaliza: es el límite de confianza del sistema.')
    const invalid = permissions.filter((x) => !isPermission(x))
    if (invalid.length) throw Errors.field('permissions', `Permisos desconocidos: ${invalid.join(', ')}.`)
    if (permissions.includes('platform.tenant.manage')) throw Errors.field('permissions', 'Solo el SuperAdmin (ROL-001) puede tener el permiso de gobierno de la plataforma.')
    const before = (await this.matrix.matrix()).find((r) => r.role === role)
    const perms = [...new Set(permissions)] as Permission[]
    await this.db.roleOverride.upsert({ where: { roleId: role }, create: { roleId: role, permissions: perms, updatedBy: 'SuperAdmin' }, update: { permissions: perms, updatedBy: 'SuperAdmin' } })
    this.matrix.invalidate()
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Rol', resourceId: ROLES[role].name, action: 'role_permissions.update', before: `${before?.permissions.length ?? 0} permiso(s)`, after: `${perms.length} permiso(s): ${perms.join(', ')}` })
    return (await this.matrix.matrix()).find((r) => r.role === role)
  }

  async resetRole(role: string) {
    if (!isRoleId(role)) throw Errors.notFound('Rol inexistente.')
    if (role === 'ROL-001') throw Errors.forbidden('El rol de gobierno de la plataforma no se personaliza.')
    await this.db.roleOverride.deleteMany({ where: { roleId: role } })
    this.matrix.invalidate()
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Rol', resourceId: ROLES[role].name, action: 'role_permissions.reset', after: 'Restablecido a la matriz base de DOC-A' })
    return (await this.matrix.matrix()).find((r) => r.role === role)
  }

  async getSettings() {
    return this.settings.get()
  }

  async updateSettings(i: { quickAccessCardsEnabled: boolean; graceDays: number }) {
    if (!Number.isInteger(i.graceDays) || i.graceDays < 0 || i.graceDays > 60) throw Errors.field('graceDays', 'Ingrese un número entero de días de gracia, entre 0 y 60.')
    const before = await this.settings.get()
    await this.db.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, ...i }, update: i })
    this.settings.invalidate()
    await this.audit.record({
      kind: 'Seguridad', tenantId: null, resourceType: 'Ajustes de plataforma', resourceId: 'Instalación', action: 'platform_settings.update',
      before: `Tarjetas ${before.quickAccessCardsEnabled ? 'activas' : 'inactivas'} · ${before.graceDays} días de gracia`, after: `Tarjetas ${i.quickAccessCardsEnabled ? 'activas' : 'inactivas'} · ${i.graceDays} días de gracia`,
    })
    return this.settings.get()
  }
}
