import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { OrgUnit, OrgUnitType, UserRole, UserScope, User } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { ORG_TYPE, USER_STATUS } from '../../common/labels'
import { pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, iso } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { AuditService } from '../audit/audit.service'
import { PasswordHasher, passwordProblems } from '../auth/password-hasher'
import type { CreateOrgUnitDto, CreateUserDto, ScopeDto, UpdateOrgUnitDto, UpdateUserDto } from './access.dto'
import { isRoleId, PLATFORM_ONLY_ROLES, TENANT_ADMIN_ROLES, type RoleId } from './domain/catalog'
import type { Principal, ScopeRef } from './domain/principal'
import { RoleMatrixService } from './role-matrix.service'

type UserRow = User & { roles: UserRole[]; scopes: UserScope[] }

export const userView = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  roles: u.roles.map((r) => r.roleId).filter(isRoleId),
  scopes: u.scopes.map((s): ScopeRef => ({ type: s.type as ScopeRef['type'], ...(s.refId ? { id: s.refId } : {}), label: s.label })),
  status: USER_STATUS.label(u.status),
  lastLoginAt: iso(u.lastLoginAt),
})

export const orgUnitView = (o: OrgUnit, usage?: { vehicles: number; drivers: number; users: number }) => ({
  id: o.id,
  type: ORG_TYPE.label(o.type),
  name: o.name,
  parentId: o.parentId,
  active: o.active,
  ...(usage ? { usage } : {}),
  city: o.type === 'BASE' ? o.city : null,
  address: o.type === 'BASE' ? o.address : null,
})

/** Contraseña temporal legible (se muestra una sola vez al administrador; ver DOC-E-BE §G.4). */
export const temporaryPassword = () => `Tmp-${randomBytes(6).toString('base64url')}9`

/** Qué tipo de unidad debe referenciar cada alcance. */
const SCOPE_UNIT: Partial<Record<ScopeRef['type'], OrgUnitType[]>> = {
  BASE: ['BASE'], FLEET: ['FLOTA'], UNIT: ['UNIDAD'], ORGANIZATION: ['ORGANIZACION', 'SEDE'], OWN_ORG: ['ORGANIZACION', 'SEDE', 'UNIDAD'], CUSTOMER_ORG: ['ORGANIZACION'],
}

/**
 * Administración de usuarios, roles y estructura del negocio (FE-060/061 · RF-002/032 · PROC-001).
 * Siempre dentro del tenant de la sesión (cliente `db` con aislamiento). Un Admin de negocio nunca:
 *  - asigna roles de plataforma (RN-010) ni los cupos ROL-002/015 (los asigna el SuperAdmin, PC-A1);
 *  - desactiva su propia cuenta; ni concede alcance PLATFORM.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly matrix: RoleMatrixService,
  ) {}

  async listUsers(raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['name', 'email', 'status', 'lastLoginAt'], filters: ['role', 'status', 'access'], defaultSort: { field: 'name', dir: 'asc' } })
    const rows = await this.prisma.db.user.findMany({ include: { roles: true, scopes: true } })
    const items = rows.map(userView)
    return pageInMemory(items, q, {
      search: (u) => `${u.name} ${u.email}`,
      filters: { role: (u, v) => u.roles.includes(v as RoleId), status: (u, v) => u.status === v, access: (u, v) => (u.lastLoginAt ? 'used' : 'never') === v },
      facets: { status: (u) => u.status, access: (u) => (u.lastLoginAt ? 'used' : 'never'), role: (u) => u.roles },
      sort: { name: (u) => u.name, email: (u) => u.email, status: (u) => u.status, lastLoginAt: (u) => u.lastLoginAt },
    })
  }

  private async validateScopes(tx: Tx, scopes: ScopeDto[]): Promise<ScopeDto[]> {
    const errs = new FieldErrors()
    const out: ScopeDto[] = []
    for (const s of scopes) {
      if (s.type === 'PLATFORM') {
        errs.add('scopes', 'El alcance de plataforma no se asigna desde un negocio (RN-010).')
        continue
      }
      const unitTypes = SCOPE_UNIT[s.type]
      if (unitTypes) {
        if (!s.id) {
          errs.add('scopes', `El alcance ${s.type} requiere indicar el elemento de la organización.`)
          continue
        }
        const unit = await tx.orgUnit.findFirst({ where: { id: s.id, type: { in: unitTypes } } })
        if (!unit) {
          errs.add('scopes', `El elemento del alcance ${s.type} no existe en su organización.`)
          continue
        }
        out.push({ type: s.type, id: unit.id, label: unit.name })
      } else {
        out.push({ type: s.type, label: s.label })
      }
    }
    errs.throwIfAny()
    return out
  }

  private assertAssignableRoles(roles: RoleId[], current: RoleId[] = []): void {
    if (roles.some((r) => PLATFORM_ONLY_ROLES.includes(r))) throw Errors.forbidden('Un administrador de negocio no puede asignar roles de plataforma (RN-010).')
    // Conservar el cupo que ya asignó el SuperAdmin no cuenta; AGREGARLO desde aquí sí está prohibido.
    if (roles.some((r) => TENANT_ADMIN_ROLES.includes(r) && !current.includes(r))) {
      throw Errors.forbidden('Los cupos de Administrador Tenant y Administrador Owner los asigna el SuperAdmin desde «Administradores» (PC-A1).')
    }
  }

  async createUser(p: Principal, dto: CreateUserDto) {
    this.assertAssignableRoles(dto.roles)
    const tenantId = p.tenantId as string
    const emailKey = dto.email.trim().toLowerCase()
    const tempPassword = temporaryPassword()
    const passwordHash = await this.hasher.hash(tempPassword)
    const created = await this.prisma.tx(async (tx) => {
      if (await tx.user.findFirst({ where: { emailKey }, select: { id: true } })) throw Errors.field('email', 'Ya existe un usuario con ese correo en este negocio.')
      const scopes = await this.validateScopes(tx, dto.scopes)
      if (dto.driverId) {
        if (!dto.roles.includes('ROL-008')) throw Errors.field('driverId', 'Solo una cuenta con rol Conductor se vincula a un conductor.')
        const d = await tx.driver.findFirst({ where: { id: dto.driverId } })
        if (!d) throw Errors.field('driverId', 'El conductor no existe en su organización.')
        if (d.userId) throw Errors.field('driverId', 'El conductor ya tiene una cuenta vinculada.')
      }
      const u = await tx.user.create({
        data: {
          tenantId,
          name: clean(dto.name),
          email: dto.email.trim(),
          emailKey,
          passwordHash,
          document: dto.roles.includes('ROL-014') ? (dto.document?.trim().toUpperCase() ?? null) : null,
          roles: { create: dto.roles.map((roleId) => ({ roleId, tenantId })) },
          scopes: { create: scopes.map((s) => ({ tenantId, type: s.type, refId: s.id ?? null, label: s.label })) },
        },
        include: { roles: true, scopes: true },
      })
      if (dto.driverId) await tx.driver.update({ where: { id: dto.driverId }, data: { userId: u.id } })
      await this.audit.record({ resourceType: 'Usuario', resourceId: u.email, action: 'user.create', after: dto.roles.join(', ') }, tx)
      return u
    })
    // La contraseña temporal se devuelve UNA sola vez; nunca se guarda en claro ni se audita.
    return { ...userView(created), temporaryPassword: tempPassword }
  }

  async updateUser(p: Principal, id: string, dto: UpdateUserDto) {
    return this.prisma.tx(async (tx) => {
      const u = await tx.user.findFirst({ where: { id }, include: { roles: true, scopes: true } })
      if (!u) throw Errors.unavailable()
      const current = u.roles.map((r) => r.roleId).filter(isRoleId)
      if (dto.roles) this.assertAssignableRoles(dto.roles, current)
      const status = dto.status ? USER_STATUS.parse(dto.status) : undefined
      if (u.id === p.userId && status && status !== 'ACTIVO') throw Errors.forbidden('No puede desactivar su propia cuenta.')
      if (u.id === p.userId && dto.roles && !dto.roles.some((r) => current.includes(r) && TENANT_ADMIN_ROLES.includes(r)) && current.some((r) => TENANT_ADMIN_ROLES.includes(r))) {
        throw Errors.forbidden('No puede quitarse a sí mismo el cupo de administrador del negocio.')
      }
      const before = `${current.join(',')} / ${USER_STATUS.label(u.status)}`
      const tenantId = p.tenantId as string
      if (dto.roles) {
        await tx.userRole.deleteMany({ where: { userId: u.id } })
        await tx.userRole.createMany({ data: dto.roles.map((roleId) => ({ userId: u.id, roleId, tenantId })) })
      }
      if (dto.scopes) {
        const scopes = await this.validateScopes(tx, dto.scopes)
        await tx.userScope.deleteMany({ where: { userId: u.id } })
        await tx.userScope.createMany({ data: scopes.map((s) => ({ userId: u.id, tenantId, type: s.type, refId: s.id ?? null, label: s.label })) })
      }
      if (status) await tx.user.update({ where: { id: u.id }, data: { status } })
      // Desactivar o bloquear corta las sesiones al instante (el principal se recarga en cada petición).
      if (status && status !== 'ACTIVO') await tx.authSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: `user.${status.toLowerCase()}` } })
      const next = await tx.user.findFirstOrThrow({ where: { id: u.id }, include: { roles: true, scopes: true } })
      const view = userView(next)
      await this.audit.record({ kind: status && status !== u.status ? 'Seguridad' : 'Negocio', resourceType: 'Usuario', resourceId: u.email, action: 'user.update', before, after: `${view.roles.join(',')} / ${view.status}`, reason: dto.reason ?? null }, tx)
      return view
    })
  }

  async listOrgUnits() {
    const db = this.prisma.db
    const [units, vehicles, drivers, scopes] = await Promise.all([
      db.orgUnit.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
      db.vehicle.findMany({ select: { baseId: true, fleetId: true } }),
      db.driver.findMany({ select: { baseId: true } }),
      db.userScope.findMany({ select: { type: true, refId: true } }),
    ])
    const children = new Map<string, string[]>()
    for (const u of units) if (u.parentId) children.set(u.parentId, [...(children.get(u.parentId) ?? []), u.id])
    const subtree = (id: string): Set<string> => {
      const s = new Set([id])
      for (const c of children.get(id) ?? []) subtree(c).forEach((x) => s.add(x))
      return s
    }
    return units.map((o) => {
      const ids = subtree(o.id)
      return orgUnitView(o, {
        vehicles: vehicles.filter((v) => ids.has(v.baseId) || ids.has(v.fleetId)).length,
        drivers: drivers.filter((d) => ids.has(d.baseId)).length,
        users: scopes.filter((s) => (s.type === 'TENANT' ? o.parentId === null : s.refId === o.id)).length,
      })
    })
  }

  async createOrgUnit(p: Principal, dto: CreateOrgUnitDto) {
    const type = ORG_TYPE.parse(dto.type)
    if (!type) throw Errors.field('type', 'Tipo inválido.')
    const errs = new FieldErrors()
    errs.when(type === 'BASE' && !clean(dto.city), 'city', 'Indique la ciudad de la terminal: distingue terminales del mismo nombre o de la misma zona.')
    errs.throwIfAny()
    return this.prisma.tx(async (tx) => {
      if (await tx.orgUnit.findFirst({ where: { type, name: { equals: clean(dto.name), mode: 'insensitive' } }, select: { id: true } })) throw Errors.field('name', 'Ya existe un elemento con ese nombre y tipo.')
      if (dto.parentId && !(await tx.orgUnit.findFirst({ where: { id: dto.parentId }, select: { id: true } }))) throw Errors.field('parentId', 'El elemento superior no existe.')
      const o = await tx.orgUnit.create({
        data: { tenantId: p.tenantId as string, type, name: clean(dto.name), parentId: dto.parentId ?? null, city: type === 'BASE' ? clean(dto.city) : null, address: type === 'BASE' ? clean(dto.address) || null : null },
      })
      await this.audit.record({ resourceType: 'Organización', resourceId: o.name, action: 'org.create', after: dto.type }, tx)
      return orgUnitView(o)
    })
  }

  async updateOrgUnit(id: string, dto: UpdateOrgUnitDto) {
    return this.prisma.tx(async (tx) => {
      const o = await tx.orgUnit.findFirst({ where: { id } })
      if (!o) throw Errors.unavailable()
      const data: { name?: string; active?: boolean; city?: string; address?: string | null } = {}
      if (dto.name !== undefined) data.name = clean(dto.name)
      if (dto.active !== undefined) data.active = dto.active
      if (o.type === 'BASE') {
        if (dto.city !== undefined) {
          if (!clean(dto.city)) throw Errors.field('city', 'La ciudad no puede quedar vacía.')
          data.city = clean(dto.city)
        }
        if (dto.address !== undefined) data.address = clean(dto.address) || null
      }
      const next = await tx.orgUnit.update({ where: { id }, data })
      await this.audit.record({ resourceType: 'Organización', resourceId: next.name, action: 'org.update', before: o.active ? 'Activa' : 'Inactiva', after: dto.active === false ? 'Inactivada' : 'Actualizada' }, tx)
      return orgUnitView(next)
    })
  }

  /** Solo lectura, sin ROL-001: vista previa de permisos efectivos al asignar roles (PC-A1 Fase 3). */
  async roleMatrix() {
    return (await this.matrix.matrix()).filter((r) => r.role !== 'ROL-001')
  }

  async lookups() {
    const os = await this.prisma.db.orgUnit.findMany({ where: { active: true, type: { in: ['FLOTA', 'BASE'] } }, orderBy: { name: 'asc' } })
    return { fleets: os.filter((o) => o.type === 'FLOTA').map((o) => orgUnitView(o)), bases: os.filter((o) => o.type === 'BASE').map((o) => orgUnitView(o)) }
  }

  /** PROPUESTA DE AJUSTE (§G.4): cambio de contraseña propia (necesario tras la contraseña temporal). */
  async changePassword(p: Principal, current: string, next: string) {
    const problem = passwordProblems(next)
    if (problem) throw Errors.field('newPassword', problem)
    const u = await this.prisma.system.user.findUnique({ where: { id: p.userId } })
    if (!u || !(await this.hasher.verify(current, u.passwordHash))) throw Errors.field('currentPassword', 'La contraseña actual no es correcta.')
    await this.prisma.system.$transaction([
      this.prisma.system.user.update({ where: { id: u.id }, data: { passwordHash: await this.hasher.hash(next) } }),
      // Las demás sesiones abiertas se cierran; la actual sigue viva.
      this.prisma.system.authSession.updateMany({ where: { userId: u.id, revokedAt: null, NOT: { familyId: p.sessionId } }, data: { revokedAt: new Date(), revokeReason: 'password.change' } }),
    ])
    await this.audit.record({ kind: 'Seguridad', tenantId: p.tenantId, resourceType: 'Usuario', resourceId: u.email, action: 'user.password.change' })
  }
}
