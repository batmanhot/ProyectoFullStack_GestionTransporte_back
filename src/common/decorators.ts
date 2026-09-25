import { createParamDecorator, SetMetadata } from '@nestjs/common'
import { RequestContext } from './context/request-context'
import { Errors } from './errors/app-error'
import type { Permission } from '../modules/access/domain/catalog'
import type { Principal } from '../modules/access/domain/principal'

export const IS_PUBLIC = 'tr:isPublic'
export const REQUIRED_PERMS = 'tr:requiredPerms'
export const IDEMPOTENT = 'tr:idempotent'
export const THROTTLE_POLICY = 'tr:throttlePolicy'

/** Endpoint sin sesión (login, refresh, health, públicos). Todo lo demás exige autenticación por defecto. */
export const Public = () => SetMetadata(IS_PUBLIC, true)

/**
 * Autorización por PERMISO (no por rol): basta con uno de los indicados (DOC-A §J · prompt §12).
 * El alcance (scope) y las políticas (SoD, gate, estado) se evalúan después, en el servicio de dominio.
 */
export const RequirePermission = (...anyOf: Permission[]) => SetMetadata(REQUIRED_PERMS, anyOf)

/** Acepta `Idempotency-Key`: misma clave + misma intención ⇒ misma respuesta (ADR-002). */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true)

/** Principal autenticado de la petición (lo fija el AuthGuard). */
export const CurrentPrincipal = createParamDecorator((): Principal => {
  const p = RequestContext.principal()
  if (!p) throw Errors.unauthenticated()
  return p
})
