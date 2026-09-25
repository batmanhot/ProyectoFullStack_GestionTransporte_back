import { Injectable } from '@nestjs/common'
import type { Prisma, Tenant, TenantDeployment, TenantLifecycle, TenantSubscription } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { DEPLOYMENT_MODE, PLAN, TENANT_LIFECYCLE } from '../../common/labels'
import { pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, iso } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { PasswordHasher, passwordProblems } from '../auth/password-hasher'

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** EXC-001/002, GAP-003: «Cerrado» exige política de retención/exportación ⇒ bloqueado. Suspender NO borra datos. */
const FLOW: Record<TenantLifecycle, TenantLifecycle[]> = {
  BORRADOR: ['CONFIGURADO'], CONFIGURADO: ['ACTIVO'], ACTIVO: ['SUSPENDIDO', 'CERRADO'], SUSPENDIDO: ['REACTIVADO', 'CERRADO'], REACTIVADO: ['SUSPENDIDO', 'CERRADO'], CERRADO: [],
}
/** Catálogos iniciales de un negocio nuevo (PC-A8/PC-A11): el negocio los edita luego (PC-A19). */
const DEFAULT_CATALOG: { kind: 'CARGO_TYPE' | 'SERVICE_TYPE'; label: string; hint: string }[] = [
  { kind: 'CARGO_TYPE', label: 'General', hint: 'Mercadería seca sin condiciones especiales.' },
  { kind: 'CARGO_TYPE', label: 'Refrigerada', hint: 'Requiere cadena de frío.' },
  { kind: 'CARGO_TYPE', label: 'Peligrosa', hint: 'Materiales peligrosos: documentación y manejo especial.' },
  { kind: 'CARGO_TYPE', label: 'Frágil', hint: 'Manipulación cuidadosa.' },
  { kind: 'CARGO_TYPE', label: 'Granel', hint: 'Carga suelta sin embalaje.' },
  { kind: 'SERVICE_TYPE', label: 'Interprovincial', hint: 'Pasajeros entre ciudades.' },
  { kind: 'SERVICE_TYPE', label: 'Transporte de personal', hint: 'Personal de una empresa cliente.' },
  { kind: 'SERVICE_TYPE', label: 'Carga dedicada', hint: 'Flota asignada a un cliente de carga.' },
  { kind: 'SERVICE_TYPE', label: 'Turismo', hint: 'Excursiones y traslados turísticos.' },
  { kind: 'SERVICE_TYPE', label: 'Otro', hint: 'Otro tipo de servicio.' },
]

type TenantRow = Tenant & { subscriptions: TenantSubscription[]; deployment: TenantDeployment | null }

export const subscriptionView = (s: TenantSubscription | undefined) =>
  s ? { plan: PLAN.label(s.plan), billingCycle: 'Mensual' as const, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() } : null

export const deploymentView = (d: TenantDeployment | null) =>
  d
    ? { mode: DEPLOYMENT_MODE.label(d.mode), version: d.version, capacityContract: d.capacityContract, technicalContact: d.technicalContact, supportChannel: d.supportChannel, monitoringAuthorized: d.monitoringAuthorized, licenseStatus: d.licenseStatus, lastUpdatedAt: iso(d.lastUpdatedAt), lastBackupVerifiedAt: iso(d.lastBackupVerifiedAt) }
    : null

function subscriptionErrors(i: { plan: string; startsAt: string; endsAt: string }, errs: FieldErrors) {
  const valid = (v: string) => DATE_RE.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v
  errs.when(!PLAN.parse(i.plan), 'commercialPlan', 'Seleccione un plan comercial válido.')
  errs.when(!valid(i.startsAt), 'subscriptionStartsAt', 'Ingrese una fecha de inicio válida.')
  if (!valid(i.endsAt)) errs.add('subscriptionEndsAt', 'Ingrese una fecha de término válida.')
  else errs.when(i.endsAt <= i.startsAt, 'subscriptionEndsAt', 'La fecha de término debe ser posterior al inicio.')
}
const noon = (d: string) => new Date(`${d}T12:00:00Z`)

/**
 * Negocios / tenants (RF-001 · PROC-001 · prompt §14–16). Solo ROL-001 (PERM-001, alcance PLATFORM). Opera con el cliente
 * `system` porque su objeto de trabajo SON los tenants, pero nunca lee contenido operativo de un negocio (solo contadores).
 */
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
  ) {}

  private async view(t: TenantRow, tx: Tx = this.prisma.system) {
    const [users, vehicles, active] = await Promise.all([
      tx.user.count({ where: { tenantId: t.id } }),
      tx.vehicle.count({ where: { tenantId: t.id } }),
      tx.trip.count({ where: { tenantId: t.id, lifecycle: { in: ['EN_RUTA', 'EN_DESTINO'] } } }),
    ])
    return {
      id: t.id, slug: t.slug, name: t.name, lifecycle: TENANT_LIFECYCLE.label(t.lifecycle), timezone: t.timezone, adminContact: t.adminContact, createdAt: t.createdAt.toISOString(),
      usersCount: users, vehiclesCount: vehicles, activeTripsCount: active, ...(t.lastChangeReason ? { lastChangeReason: t.lastChangeReason } : {}),
      commercialSubscription: subscriptionView(t.subscriptions.find((s) => s.current)), deployment: deploymentView(t.deployment),
    }
  }

  private include = { subscriptions: { where: { current: true } }, deployment: true } satisfies Prisma.TenantInclude

  async list(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['name', 'slug', 'createdAt', 'lifecycle'], filters: ['lifecycle'], defaultSort: { field: 'name', dir: 'asc' } })
    const rows = await this.prisma.system.tenant.findMany({ include: this.include, orderBy: { name: 'asc' } })
    const items = await Promise.all(rows.map((t) => this.view(t)))
    return pageInMemory(items, q, {
      search: (t) => `${t.name} ${t.slug} ${t.adminContact}`,
      filters: { lifecycle: (t, v) => t.lifecycle === v },
      facets: { lifecycle: (t) => t.lifecycle },
      sort: { name: (t) => t.name, slug: (t) => t.slug, createdAt: (t) => t.createdAt, lifecycle: (t) => t.lifecycle },
    })
  }

  async viewById(id: string) {
    return this.view(await this.one(id))
  }

  async one(id: string) {
    const t = await this.prisma.system.tenant.findUnique({ where: { id }, include: this.include })
    if (!t) throw Errors.notFound('El negocio no existe.')
    return t
  }

  async create(
    p: Principal,
    i: {
      name: string; slug: string; timezone: string; adminContact: string
      commercialSubscription: { plan: string; startsAt: string; endsAt: string }
      administrators: { owner: { name: string; email: string; initialPassword: string }; tenant: { name: string; email: string; initialPassword: string } }
    },
  ) {
    const errs = new FieldErrors()
    const slug = clean(i.slug).toLowerCase()
    errs.when(clean(i.name).length < 3, 'name', 'Ingrese el nombre de la empresa.')
    errs.when(!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 48, 'slug', 'El slug debe tener entre 3 y 48 caracteres: minúsculas, números y guiones.')
    errs.when(!EMAIL_RE.test(clean(i.adminContact)), 'adminContact', 'Ingrese un correo administrativo válido.')
    errs.when(!isValidTimezone(i.timezone), 'timezone', 'Zona horaria inválida (formato IANA, p. ej. America/Lima).')
    subscriptionErrors(i.commercialSubscription, errs)
    const admins = [
      { role: 'ROL-015' as const, key: 'owner', label: 'Admin Owner', v: i.administrators.owner },
      { role: 'ROL-002' as const, key: 'tenant', label: 'Admin Tenant', v: i.administrators.tenant },
    ]
    for (const a of admins) {
      errs.when(clean(a.v.name).length < 3, `${a.key}Name`, `Ingrese el nombre del ${a.label}.`)
      errs.when(!EMAIL_RE.test(clean(a.v.email)), `${a.key}Email`, `Ingrese un correo válido para ${a.label}.`)
      const pw = passwordProblems(a.v.initialPassword)
      if (pw) errs.add(`${a.key}Password`, `${a.label}: ${pw}`)
    }
    errs.when(clean(admins[0]!.v.email).toLowerCase() === clean(admins[1]!.v.email).toLowerCase(), 'tenantEmail', 'Cada administrador debe tener un correo distinto.')
    errs.throwIfAny()
    const hashes = await Promise.all(admins.map((a) => this.hasher.hash(a.v.initialPassword)))
    const id = await this.prisma.systemTx(async (tx) => {
      const dup = new FieldErrors()
      if (await tx.tenant.findFirst({ where: { name: { equals: clean(i.name), mode: 'insensitive' } }, select: { id: true } })) dup.add('name', 'Ya existe una empresa con ese nombre.')
      if (await tx.tenant.findUnique({ where: { slug }, select: { id: true } })) dup.add('slug', 'Este slug ya está reservado por otra empresa.')
      dup.throwIfAny()
      const s = i.commercialSubscription
      const t = await tx.tenant.create({
        data: {
          slug, name: clean(i.name), timezone: i.timezone, adminContact: clean(i.adminContact), lifecycle: 'ACTIVO',
          subscriptions: { create: { plan: PLAN.parse(s.plan)!, startsAt: noon(s.startsAt), endsAt: noon(s.endsAt), createdBy: p.name, reason: 'Alta del negocio' } },
          deployment: { create: { mode: 'SAAS', version: 'Cloud', capacityContract: 'Según plan comercial', technicalContact: clean(i.adminContact), supportChannel: 'Soporte estándar', lastUpdatedAt: new Date() } },
        },
      })
      for (const [n, a] of admins.entries()) {
        const u = await tx.user.create({
          data: {
            tenantId: t.id, name: clean(a.v.name), email: clean(a.v.email), emailKey: clean(a.v.email).toLowerCase(), passwordHash: hashes[n]!,
            roles: { create: [{ roleId: a.role, tenantId: t.id }] }, scopes: { create: [{ tenantId: t.id, type: 'TENANT', refId: t.id, label: t.name }] },
          },
        })
        await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Administrador de negocio', resourceId: `${t.name} · ${u.email}`, action: 'tenant_admin.assign', after: a.label }, tx)
      }
      await tx.catalogItem.createMany({ data: DEFAULT_CATALOG.map((c) => ({ tenantId: t.id, kind: c.kind, label: c.label, labelKey: c.label.toLowerCase(), hint: c.hint, createdBy: 'Sistema' })) })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Tenant', resourceId: t.name, action: 'tenant.create', after: `Activo · ${s.plan} hasta ${s.endsAt}` }, tx)
      return t.id
    })
    return this.view(await this.one(id))
  }

  async update(id: string, i: { name: string; timezone: string; adminContact: string }) {
    const errs = new FieldErrors()
    errs.when(clean(i.name).length < 3, 'name', 'Ingrese el nombre del negocio.')
    errs.when(!EMAIL_RE.test(clean(i.adminContact)), 'adminContact', 'Ingrese un correo válido.')
    errs.when(!isValidTimezone(i.timezone), 'timezone', 'Zona horaria inválida (formato IANA).')
    errs.throwIfAny()
    const t = await this.one(id)
    if (await this.prisma.system.tenant.findFirst({ where: { id: { not: id }, name: { equals: clean(i.name), mode: 'insensitive' } }, select: { id: true } })) throw Errors.field('name', 'Ya existe un negocio con ese nombre.')
    await this.prisma.system.tenant.update({ where: { id }, data: { name: clean(i.name), timezone: i.timezone, adminContact: clean(i.adminContact) } })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Tenant', resourceId: clean(i.name), action: 'tenant.update', before: `${t.name} · ${t.timezone} · ${t.adminContact}`, after: `${clean(i.name)} · ${i.timezone} · ${clean(i.adminContact)}` })
    return this.view(await this.one(id))
  }

  async transition(id: string, toLabel: string, reason: string) {
    const to = TENANT_LIFECYCLE.parse(toLabel)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    if (clean(reason).length < 10) throw Errors.field('reason', 'El motivo es obligatorio (mín. 10 caracteres).')
    const t = await this.one(id)
    if (!FLOW[t.lifecycle].includes(to)) throw Errors.conflict('Transición inválida', `Un negocio «${TENANT_LIFECYCLE.label(t.lifecycle)}» no puede pasar a «${toLabel}».`)
    if (to === 'CERRADO') throw Errors.conflict('Cierre bloqueado', 'El cierre requiere política de retención/exportación confirmada (GAP-003). El negocio y sus datos se conservan.')
    await this.prisma.systemTx(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { lifecycle: to, lastChangeReason: clean(reason) } })
      // Suspender corta las sesiones al instante (el principal ya lo rechaza; revocar libera también los refresh).
      if (to === 'SUSPENDIDO') await tx.authSession.updateMany({ where: { tenantId: id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'tenant.suspended' } })
      await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Tenant', resourceId: t.name, action: 'tenant.transition', before: TENANT_LIFECYCLE.label(t.lifecycle), after: toLabel, reason: clean(reason) }, tx)
    })
    return this.view(await this.one(id))
  }

  /** Renovación / cambio de plan (PC-A1 F4): nueva vigencia que REEMPLAZA la actual (no acumula); la anterior queda en historial. */
  async renew(p: Principal, id: string, i: { plan: string; startsAt: string; endsAt: string; reason?: string }) {
    const errs = new FieldErrors()
    subscriptionErrors(i, errs)
    const t = await this.one(id)
    if (i.plan !== 'Enterprise' && t.deployment && t.deployment.mode !== 'SAAS') {
      errs.add('commercialPlan', `Este negocio tiene un despliegue "${DEPLOYMENT_MODE.label(t.deployment.mode)}", que requiere Enterprise. Vuelva a SaaS compartido antes de bajar de plan.`)
    }
    errs.throwIfAny()
    const prev = t.subscriptions.find((s) => s.current)
    await this.prisma.systemTx(async (tx) => {
      await tx.tenantSubscription.updateMany({ where: { tenantId: id, current: true }, data: { current: false } })
      await tx.tenantSubscription.create({ data: { tenantId: id, plan: PLAN.parse(i.plan)!, startsAt: noon(i.startsAt), endsAt: noon(i.endsAt), createdBy: p.name, reason: clean(i.reason) || null } })
      await this.audit.record({
        kind: 'Seguridad', tenantId: null, resourceType: 'Suscripción de tenant', resourceId: t.name, action: 'tenant.subscription.renew',
        before: prev ? `${PLAN.label(prev.plan)} · vigente hasta ${prev.endsAt.toISOString().slice(0, 10)}` : null, after: `${i.plan} · vigente hasta ${i.endsAt}`, reason: clean(i.reason) || null,
      }, tx)
    })
    return subscriptionView((await this.one(id)).subscriptions.find((s) => s.current))
  }

  /** Metadatos contractuales de despliegue (FE-077). Nunca credenciales, IPs ni datos operativos. */
  async updateDeployment(id: string, i: { mode: string; version: string; capacityContract: string; technicalContact: string; supportChannel: string; monitoringAuthorized: boolean; licenseStatus: string; reason?: string }) {
    const mode = DEPLOYMENT_MODE.parse(i.mode)
    const t = await this.one(id)
    const plan = t.subscriptions.find((s) => s.current)?.plan
    const errs = new FieldErrors()
    errs.when(!mode, 'mode', 'Modalidad inválida.')
    errs.when(!!mode && mode !== 'SAAS' && plan !== 'ENTERPRISE', 'mode', 'La nube privada, On-premise y el modo híbrido requieren el plan Enterprise.')
    errs.when(!clean(i.version), 'version', 'Indique la versión o edición instalada.')
    errs.when(clean(i.capacityContract).length < 8, 'capacityContract', 'Indique la capacidad contractual.')
    errs.when(!EMAIL_RE.test(clean(i.technicalContact)), 'technicalContact', 'Ingrese un correo técnico válido.')
    errs.throwIfAny()
    const before = t.deployment ? `${DEPLOYMENT_MODE.label(t.deployment.mode)} · ${t.deployment.version}` : null
    const data = { mode: mode!, version: clean(i.version), capacityContract: clean(i.capacityContract), technicalContact: clean(i.technicalContact), supportChannel: clean(i.supportChannel), monitoringAuthorized: i.monitoringAuthorized, licenseStatus: clean(i.licenseStatus), lastUpdatedAt: new Date() }
    const d = await this.prisma.system.tenantDeployment.upsert({ where: { tenantId: id }, create: { tenantId: id, ...data }, update: data })
    await this.audit.record({ kind: 'Seguridad', tenantId: null, resourceType: 'Despliegue de tenant', resourceId: t.name, action: 'tenant.deployment.update', before, after: `${i.mode} · ${data.version}`, reason: clean(i.reason) || null })
    return deploymentView(d)
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return /^[A-Za-z_]+\/[A-Za-z_\-/]+$/.test(tz) || tz === 'UTC'
  } catch {
    return false
  }
}
