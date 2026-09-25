/**
 * Modelo de error (DOC-E-BE §W · ADR-013): application/problem+json con códigos estables.
 * Los códigos coinciden con `ErrorCode` de DOC-D-FE (core/http/problem.ts). `RATE_LIMITED` y `NOT_FOUND` son nuevos
 * (PROPUESTA DE AJUSTE DE CONTRATO al FE: hoy caen en su rama por defecto sin romper nada).
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'TENANT_CONTEXT_INVALID'
  | 'RESOURCE_CONFLICT'
  | 'GATE_NOT_SATISFIED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_DEPENDENCY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'

export interface FieldError {
  field: string
  message: string
}

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: ErrorCode
  detail?: string
  correlationId: string
  errors?: FieldError[]
  extensions?: Record<string, unknown>
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: { errors?: FieldError[]; extensions?: Record<string, unknown> } = {},
  ) {
    super(detail ?? title)
    this.name = 'AppError'
  }
}

/** Fábricas con el vocabulario del dominio. Mensajes en español: «qué pasó + cómo resolverlo». */
export const Errors = {
  validation: (errors: FieldError[], detail?: string) => new AppError('VALIDATION_ERROR', 422, 'Datos inválidos', detail, { errors }),
  field: (field: string, message: string) => new AppError('VALIDATION_ERROR', 422, 'Datos inválidos', undefined, { errors: [{ field, message }] }),
  unauthenticated: (detail = 'Su sesión no es válida o expiró.') => new AppError('UNAUTHENTICATED', 401, 'No autenticado', detail),
  forbidden: (detail = 'No tiene permiso o alcance para esta acción.', extensions?: Record<string, unknown>) =>
    new AppError('FORBIDDEN', 403, 'Acción no permitida', detail, { extensions }),
  /** Recurso inexistente O fuera de alcance: misma respuesta, para no revelar existencia (RN-010). */
  unavailable: (detail = 'El recurso no existe o está fuera de su alcance.') => new AppError('FORBIDDEN', 403, 'Recurso no disponible', detail),
  notFound: (detail: string) => new AppError('NOT_FOUND', 404, 'Recurso inexistente', detail),
  tenantInvalid: (detail?: string, extensions?: Record<string, unknown>) =>
    new AppError('TENANT_CONTEXT_INVALID', 403, 'Acceso restringido', detail, { extensions }),
  conflict: (title: string, detail?: string, extensions?: Record<string, unknown>) => new AppError('RESOURCE_CONFLICT', 409, title, detail, { extensions }),
  staleVersion: (detail = 'Otro usuario modificó este registro. Recargue para ver la versión actual.') =>
    new AppError('RESOURCE_CONFLICT', 409, 'Versión desactualizada', detail, { extensions: { reason: 'VERSION_MISMATCH' } }),
  gate: (gate: unknown, detail?: string) => new AppError('GATE_NOT_SATISFIED', 422, 'Viaje no habilitado', detail, { extensions: { gate } }),
  idempotency: () =>
    new AppError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key reutilizada con otra intención', 'La misma clave de operación se usó con datos distintos. No se repitió el efecto.'),
  external: (detail: string) => new AppError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 503, 'Servicio externo no disponible', detail),
}

/** Acumulador de errores de campo para validaciones de negocio con varios mensajes a la vez. */
export class FieldErrors {
  private readonly list: FieldError[] = []
  add(field: string, message: string): this {
    this.list.push({ field, message })
    return this
  }
  when(cond: boolean, field: string, message: string): this {
    if (cond) this.add(field, message)
    return this
  }
  get size(): number {
    return this.list.length
  }
  throwIfAny(detail?: string): void {
    if (this.list.length) throw Errors.validation([...this.list], detail)
  }
}
