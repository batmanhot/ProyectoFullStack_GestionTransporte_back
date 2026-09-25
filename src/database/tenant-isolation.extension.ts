import { Prisma } from '../generated/prisma/client'
import { RequestContext } from '../common/context/request-context'

/**
 * Aislamiento de tenant CENTRALIZADO (DOC-E-BE §I · ADR-005 · NFR-001 · RN-010).
 *
 * Toda operación sobre un modelo con `tenantId` recibe el tenant de la SESIÓN (RequestContext), nunca de la petición:
 *  - lecturas/actualizaciones/borrados: se agrega `tenantId` al `where` (incluido findUnique, que admite filtros extra);
 *  - creaciones/upserts: se fija `tenantId` en `data`;
 *  - si el `where`/`data` ya trae OTRO tenantId ⇒ se rechaza (intento cross-tenant, EXC-001);
 *  - si no hay tenant en el contexto ⇒ se rechaza (fail-closed). Los flujos que deben operar sin tenant
 *    (autenticación, consola de plataforma, jobs, endpoints públicos) usan explícitamente `PrismaService.system`.
 *
 * Defensa en profundidad: RLS de PostgreSQL (migración `row_level_security`), activa y forzada; ver `tenantIsolation` más abajo.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'User', 'UserRole', 'UserScope', 'OrgUnit', 'TenantCounter', 'Vehicle', 'Driver', 'ComplianceDocument', 'MaintenanceOrder',
  'Route', 'TransportService', 'Trip', 'TripEvent', 'TripAssignment', 'GateEvaluation', 'DispatchMessage', 'TelemetryEvent',
  'VehicleLastPosition', 'IntegrationCredential', 'Alert', 'Incident', 'IncidentAction', 'CatalogItem', 'ClientProfile',
  'CargoShipment', 'ShipmentEvent', 'PassengerProfile', 'PassengerBooking', 'BookingEvent', 'StoredFile', 'Notification',
  'AuditEvent',
])

const WHERE_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany',
])
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn'])

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantIsolationError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function scopeWhere(where: unknown, tenantId: string, model: string): Obj {
  const w: Obj = isObj(where) ? { ...where } : {}
  if ('tenantId' in w && w.tenantId !== tenantId) throw new TenantIsolationError(`Filtro cross-tenant rechazado en ${model}`)
  w.tenantId = tenantId
  return w
}

function scopeData(data: unknown, tenantId: string, model: string): Obj {
  if (!isObj(data)) throw new TenantIsolationError(`Datos inválidos para ${model}`)
  if ('tenantId' in data && data.tenantId !== undefined && data.tenantId !== tenantId) {
    throw new TenantIsolationError(`Escritura cross-tenant rechazada en ${model}`)
  }
  // Si la creación usa la relación (`tenant: { connect }`), no se agrega el escalar para no mezclar ambos estilos.
  if ('tenant' in data) return data
  return { ...data, tenantId }
}

/** Aplica el aislamiento a los argumentos de una operación. Exportado para pruebas unitarias. */
export function isolateArgs(model: string, operation: string, args: unknown, tenantId: string | null): unknown {
  if (!TENANT_SCOPED_MODELS.has(model)) return args
  if (!tenantId) throw new TenantIsolationError(`Operación ${model}.${operation} sin contexto de tenant (fail-closed)`)
  const a: Obj = isObj(args) ? { ...args } : {}
  if (WHERE_OPS.has(operation)) a.where = scopeWhere(a.where, tenantId, model)
  if (CREATE_OPS.has(operation)) {
    a.data = Array.isArray(a.data) ? a.data.map((d: unknown) => scopeData(d, tenantId, model)) : scopeData(a.data, tenantId, model)
  }
  if (operation === 'upsert') {
    a.where = scopeWhere(a.where, tenantId, model)
    a.create = scopeData(a.create, tenantId, model)
  }
  return a
}

/** Fija el tenant de la transacción en curso para las políticas RLS de PostgreSQL (`current_setting('app.tenant_id')`). */
export const setTenantSql = (tenantId: string | null) => Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`

/**
 * Extensión de aislamiento en DOS capas:
 *  1) aplicación: `isolateArgs` fuerza el tenant de la sesión en cada consulta (fail-closed);
 *  2) base de datos: la consulta se ejecuta en una transacción que primero fija `app.tenant_id`, y las políticas RLS de
 *     PostgreSQL (rol sin BYPASSRLS) descartan cualquier fila de otro tenant aunque la capa 1 fallara.
 * `base` es el cliente SIN extender del rol de la aplicación.
 */
export const tenantIsolation = (base: { $transaction: (queries: unknown[]) => Promise<unknown[]>; $executeRaw: (q: Prisma.Sql) => unknown }) =>
  Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations(params) {
          const { model, operation, args, query } = params
          const tenantId = RequestContext.tenantId()
          const scoped = isolateArgs(model, operation, args, tenantId) as typeof args
          // Consulta ejecutada sobre el cliente `tx` de PrismaService.tx(): esa transacción ya fijó `app.tenant_id`.
          // Se decide POR CONSULTA (no por contexto): un servicio puede usar `db` dentro del callback de una tx, y esa
          // consulta corre en OTRA conexión, así que necesita su propia transacción con el tenant fijado.
          if ((params as unknown as { __internalParams?: { transaction?: unknown } }).__internalParams?.transaction) return query(scoped)
          const [, result] = await base.$transaction([base.$executeRaw(setTenantSql(tenantId)), query(scoped)])
          return result
        },
      },
    },
  })
