import type { Permission, RoleId, ScopeType } from './catalog'

export interface ScopeRef {
  type: ScopeType
  id?: string
  label: string
}

/** Principal autenticado (ADR-004). Se reconstruye en cada petición desde la BD: una revocación o suspensión aplica de inmediato. */
export interface Principal {
  userId: string
  name: string
  email: string
  kind: 'platform' | 'tenant'
  tenantId: string | null
  tenantName: string | null
  tenantStatus?: string
  /** Zona horaria IANA del negocio (FE-CONTRACT-031 · ADR-006). Plataforma: zona por defecto de la instalación. */
  timezone: string
  roles: RoleId[]
  permissions: Permission[]
  scopes: ScopeRef[]
  isNative: boolean
  /** Solo pasajeros (PC-A9): el documento enlaza la cuenta con sus reservas. Nunca se envía al cliente. */
  document: string | null
  sessionId: string
}

/** Vista pública del principal (contrato `Session.principal` de FE-CONTRACT-001). */
export const publicPrincipal = (p: Principal) => ({
  userId: p.userId,
  name: p.name,
  email: p.email,
  kind: p.kind,
  tenantId: p.tenantId,
  tenantName: p.tenantName,
  tenantStatus: p.tenantStatus,
  timezone: p.timezone,
  roles: p.roles,
  permissions: p.permissions,
  scopes: p.scopes,
})

export const hasPerm = (p: Principal, ...any: Permission[]) => any.some((x) => p.permissions.includes(x))
export const hasRole = (p: Principal, ...any: RoleId[]) => any.some((x) => p.roles.includes(x))
