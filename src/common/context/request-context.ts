import { AsyncLocalStorage } from 'node:async_hooks'
import type { Principal } from '../../modules/access/domain/principal'

/**
 * Contexto por petición (AsyncLocalStorage). Lo abre el hook `onRequest` y lo completa el AuthGuard.
 * - `correlationId` (ADR-012) viaja a logs, auditoría y errores.
 * - `tenantId` SOLO proviene de la sesión autenticada (ADR-005): nunca de una cabecera del cliente.
 * - `mode = 'system'` lo usan jobs, autenticación y consola de plataforma cuando operan deliberadamente sin tenant.
 */
export interface RequestContextData {
  correlationId: string
  ip: string | null
  userAgent: string | null
  principal: Principal | null
  tenantId: string | null
}

const storage = new AsyncLocalStorage<RequestContextData>()

export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn)
  },
  /** Para hooks de Fastify: entra al contexto hasta el final de la cadena asíncrona de la petición. */
  enter(data: RequestContextData): void {
    storage.enterWith(data)
  },
  get(): RequestContextData | undefined {
    return storage.getStore()
  },
  correlationId(): string {
    return storage.getStore()?.correlationId ?? 'no-request'
  },
  tenantId(): string | null {
    return storage.getStore()?.tenantId ?? null
  },
  principal(): Principal | null {
    return storage.getStore()?.principal ?? null
  },
  setPrincipal(principal: Principal): void {
    const s = storage.getStore()
    if (!s) throw new Error('RequestContext no inicializado')
    s.principal = principal
    s.tenantId = principal.tenantId
  },
  /**
   * Ejecuta `fn` con el tenant indicado y SIN usuario (integraciones autenticadas por credencial de negocio y jobs por tenant).
   * El aislamiento de Prisma aplica igual: todo lo que haga `fn` queda confinado a ese tenant.
   */
  asTenant<T>(tenantId: string, fn: () => Promise<T>, correlationId?: string): Promise<T> {
    const parent = storage.getStore()
    return storage.run(
      { correlationId: correlationId ?? parent?.correlationId ?? `job-${Date.now().toString(36)}`, ip: parent?.ip ?? null, userAgent: parent?.userAgent ?? null, principal: null, tenantId },
      fn,
    )
  },
}
