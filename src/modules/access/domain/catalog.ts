/**
 * Catálogo de roles y permisos (DOC-A §B.2, §J.1, §J.2). FUENTE DE VERDAD DEL SERVIDOR: el FE solo lo representa.
 * Supuestos heredados de DOC-D-FE (registrados como PROPUESTA DE CAMBIO A DOC-A en DOC-E-BE §H):
 *   PC-A1  ROL-015 Administrador Owner; ROL-002 ampliado a administración integral del negocio.
 *   PC-A4  ROL-003 recibe PERM-005 (driver.manage), que DOC-A no asigna a ningún rol.
 *   PC-A5  ROL-001 recibe PERM-027 (report.export) para exportar registro de negocios y auditoría global.
 *   PC-A6  ROL-012 recibe PERM-027 para emitir el manifiesto.
 *   PC-A9  PERM-028 passenger.portal (ROL-014).
 *   PC-A15 PERM-029 dispatch.message (ROL-003/007/010).
 * El «modo construcción / CRUD abierto» de DOC-D-FE §I.3 es exclusivo del bundle DEMO: el backend NO lo implementa.
 */
export const PERMISSIONS = [
  'platform.tenant.manage', 'tenant.user.manage', 'organization.configure',
  'vehicle.manage', 'driver.manage', 'resource.eligibility.view', 'maintenance.manage',
  'document.manage', 'route.manage', 'service.manage', 'trip.create', 'trip.assign',
  'trip.enable', 'trip.dispatch', 'trip.arrival.record', 'trip.close', 'trip.cancel',
  'trip.interrupt', 'trip.reassign', 'tracking.view', 'alert.manage', 'incident.manage',
  'cargo.manage', 'passenger.manage', 'driver.own_trip.execute', 'audit.view', 'report.export',
  'passenger.portal', 'dispatch.message',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const ROLE_IDS = [
  'ROL-001', 'ROL-002', 'ROL-003', 'ROL-004', 'ROL-005', 'ROL-006', 'ROL-007', 'ROL-008',
  'ROL-009', 'ROL-010', 'ROL-011', 'ROL-012', 'ROL-013', 'ROL-014', 'ROL-015',
] as const
export type RoleId = (typeof ROLE_IDS)[number]

export const isPermission = (x: string): x is Permission => (PERMISSIONS as readonly string[]).includes(x)
export const isRoleId = (x: string): x is RoleId => (ROLE_IDS as readonly string[]).includes(x)

export const ROLES: Record<RoleId, { name: string; scope: string; area: string }> = {
  'ROL-001': { name: 'Platform Owner / SuperAdmin', scope: 'PLATFORM', area: 'Plataforma' },
  'ROL-002': { name: 'Administrador Tenant', scope: 'TENANT', area: 'Administración' },
  'ROL-003': { name: 'Jefe de transporte', scope: 'TENANT/UNIT', area: 'Transporte' },
  'ROL-004': { name: 'Supervisor de flota', scope: 'BASE/FLEET', area: 'Flota' },
  'ROL-005': { name: 'Programador de rutas', scope: 'UNIT/BASE', area: 'Planificación' },
  'ROL-006': { name: 'Despachador', scope: 'BASE/UNIT', area: 'Despacho' },
  'ROL-007': { name: 'Centro de control', scope: 'BASE/UNIT', area: 'Monitoreo' },
  'ROL-008': { name: 'Conductor', scope: 'OWN_RECORDS', area: 'Operación' },
  'ROL-009': { name: 'Responsable de mantenimiento', scope: 'FLEET/BASE', area: 'Mantenimiento' },
  'ROL-010': { name: 'Responsable de seguridad', scope: 'TENANT/UNIT', area: 'Seguridad' },
  'ROL-011': { name: 'Responsable de carga', scope: 'OWN_ORG/UNIT', area: 'Carga' },
  'ROL-012': { name: 'Responsable de pasajeros', scope: 'OWN_ORG/UNIT', area: 'Pasajeros' },
  'ROL-013': { name: 'Cliente comercial', scope: 'CUSTOMER_ORG', area: 'Cliente' },
  'ROL-014': { name: 'Pasajero', scope: 'OWN_RECORDS', area: 'Pasajero' },
  'ROL-015': { name: 'Administrador Owner', scope: 'TENANT', area: 'Administración' },
}

/** PERM-### de DOC-A §J.1. */
export const PERM_ID: Record<Permission, string> = Object.fromEntries(PERMISSIONS.map((p, i) => [p, `PERM-${String(i + 1).padStart(3, '0')}`])) as Record<Permission, string>

const range = (from: number, to: number): Permission[] => PERMISSIONS.filter((_, i) => i + 1 >= from && i + 1 <= to)

/** PC-A1: los administradores integrales reciben todo salvo gobierno de plataforma y lo estrictamente personal. */
const TENANT_ADMIN_EXCLUDED: Permission[] = ['platform.tenant.manage', 'driver.own_trip.execute', 'passenger.portal']
const TENANT_ADMIN: Permission[] = PERMISSIONS.filter((p) => !TENANT_ADMIN_EXCLUDED.includes(p))

export const BASE_ROLE_PERMISSIONS: Record<RoleId, Permission[]> = {
  'ROL-001': ['platform.tenant.manage', 'audit.view', 'report.export'],
  'ROL-002': TENANT_ADMIN,
  'ROL-003': [...range(6, 22), 'driver.manage', 'audit.view', 'report.export', 'dispatch.message'],
  'ROL-004': ['vehicle.manage', ...range(6, 8), 'tracking.view', 'alert.manage', 'audit.view'],
  'ROL-005': [...range(9, 12), 'trip.cancel', 'trip.reassign'],
  'ROL-006': ['resource.eligibility.view', ...range(11, 21), 'audit.view'],
  'ROL-007': ['tracking.view', 'alert.manage', 'incident.manage', 'audit.view', 'dispatch.message'],
  'ROL-008': ['trip.arrival.record', 'driver.own_trip.execute'],
  'ROL-009': ['vehicle.manage', 'maintenance.manage', 'document.manage', 'audit.view'],
  'ROL-010': ['tracking.view', 'alert.manage', 'incident.manage', 'audit.view', 'dispatch.message'],
  'ROL-011': ['cargo.manage'],
  'ROL-012': ['passenger.manage', 'report.export'],
  'ROL-013': ['tracking.view', 'report.export'],
  'ROL-014': ['passenger.portal'],
  'ROL-015': TENANT_ADMIN,
}

/** Roles que solo asigna el SuperAdmin (PC-A1) o que son de plataforma (RN-010). */
export const PLATFORM_ONLY_ROLES: RoleId[] = ['ROL-001']
export const TENANT_ADMIN_ROLES: RoleId[] = ['ROL-002', 'ROL-015']

/** Aprobadores de flujos que exigen revisión senior (SOD-001/002, cierre de alertas/incidencias Alta/Crítica). */
export const SENIOR_REVIEWERS: RoleId[] = ['ROL-003', 'ROL-010']
export const NATIVE_APPROVERS: RoleId[] = ['ROL-002', 'ROL-015']

export const SCOPE_TYPES = ['PLATFORM', 'TENANT', 'ORGANIZATION', 'BASE', 'UNIT', 'FLEET', 'OWN_RECORDS', 'OWN_ORG', 'CUSTOMER_ORG'] as const
export type ScopeType = (typeof SCOPE_TYPES)[number]
