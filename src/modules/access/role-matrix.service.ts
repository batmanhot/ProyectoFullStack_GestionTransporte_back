import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { BASE_ROLE_PERMISSIONS, isPermission, ROLE_IDS, ROLES, type Permission, type RoleId } from './domain/catalog'

export interface RolePermissionSet {
  role: RoleId
  roleName: string
  area: string
  permissions: Permission[]
  isDefault: boolean
  editable: boolean
}

/** Tiempo máximo en que otra réplica puede ver una matriz desactualizada tras una edición del SuperAdmin. */
const CACHE_TTL_MS = 30_000

/**
 * Matriz rol→permiso vigente = base DOC-A + personalizaciones del SuperAdmin (PC-A1 Fase 3, tabla `role_override`).
 * ROL-001 nunca se personaliza y `platform.tenant.manage` nunca se concede a otro rol (se valida al escribir Y al leer).
 */
@Injectable()
export class RoleMatrixService {
  private cache: { at: number; overrides: Map<string, Permission[]> } | null = null

  constructor(private readonly prisma: PrismaService) {}

  invalidate(): void {
    this.cache = null
  }

  private async overrides(): Promise<Map<string, Permission[]>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.overrides
    const rows = await this.prisma.system.roleOverride.findMany()
    const map = new Map<string, Permission[]>()
    for (const r of rows) {
      if (r.roleId === 'ROL-001') continue
      map.set(r.roleId, r.permissions.filter(isPermission).filter((p) => p !== 'platform.tenant.manage'))
    }
    this.cache = { at: Date.now(), overrides: map }
    return map
  }

  async permissionsOf(roles: RoleId[]): Promise<Permission[]> {
    const ov = await this.overrides()
    return [...new Set(roles.flatMap((r) => ov.get(r) ?? BASE_ROLE_PERMISSIONS[r]))]
  }

  async matrix(): Promise<RolePermissionSet[]> {
    const ov = await this.overrides()
    return ROLE_IDS.map((role) => ({
      role,
      roleName: ROLES[role].name,
      area: ROLES[role].area,
      permissions: ov.get(role) ?? BASE_ROLE_PERMISSIONS[role],
      isDefault: !ov.has(role),
      editable: role !== 'ROL-001',
    }))
  }
}
