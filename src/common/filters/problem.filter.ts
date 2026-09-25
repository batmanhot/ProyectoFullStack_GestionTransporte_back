import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'
import { Prisma } from '../../generated/prisma/client'
import { TenantIsolationError } from '../../database/tenant-isolation.extension'
import { RequestContext } from '../context/request-context'
import { AppError, type ErrorCode, type FieldError, type ProblemBody } from '../errors/app-error'

const TYPE_BASE = 'https://transportes.local/problems/'

/** Errores de validación estructural (class-validator vía ValidationPipe). Ver `validation.pipe.ts`. */
export class StructuralValidationError extends Error {
  constructor(readonly errors: FieldError[]) {
    super('Datos inválidos')
  }
}

/**
 * Filtro global (DOC-E-BE §W · ADR-013): toda respuesta de error es application/problem+json con `code` estable y
 * `correlationId`. Nunca se envían trazas, SQL ni nombres internos al cliente (se registran solo en el log técnico).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors')

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const correlationId = RequestContext.correlationId()
    const body = this.toProblem(exception, correlationId)
    if (body.status >= 500) this.log.error(`[${correlationId}] ${(exception as Error)?.stack ?? String(exception)}`)
    reply.status(body.status).header('Content-Type', 'application/problem+json; charset=utf-8').header('X-Correlation-Id', correlationId).send(body)
  }

  toProblem(e: unknown, correlationId: string): ProblemBody {
    const make = (code: ErrorCode, status: number, title: string, detail?: string, extra: Partial<ProblemBody> = {}): ProblemBody => ({
      type: `${TYPE_BASE}${code.toLowerCase().replace(/_/g, '-')}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      correlationId,
      ...extra,
    })
    if (e instanceof AppError) {
      return make(e.code, e.status, e.title, e.detail, { ...(e.extra.errors ? { errors: e.extra.errors } : {}), ...(e.extra.extensions ? { extensions: e.extra.extensions } : {}) })
    }
    if (e instanceof StructuralValidationError) return make('VALIDATION_ERROR', 422, 'Datos inválidos', 'Revise los campos marcados y corrija los valores.', { errors: e.errors })
    if (e instanceof ThrottlerException) return make('RATE_LIMITED', 429, 'Demasiadas solicitudes', 'Superó el límite de solicitudes permitido. Espere unos segundos y reintente.')
    if (e instanceof TenantIsolationError) {
      // Un intento cross-tenant nunca revela nada: se responde como recurso no disponible y se registra en el log.
      this.log.warn(`[${correlationId}] ${e.message}`)
      return make('FORBIDDEN', 403, 'Recurso no disponible', 'El recurso no existe o está fuera de su alcance.')
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') return make('RESOURCE_CONFLICT', 409, 'Registro duplicado', 'Ya existe un registro con esos datos únicos. Revise los valores e intente nuevamente.')
      if (e.code === 'P2025') return make('FORBIDDEN', 403, 'Recurso no disponible', 'El recurso no existe o está fuera de su alcance.')
      if (e.code === 'P2003') return make('VALIDATION_ERROR', 422, 'Referencia inválida', 'Uno de los registros relacionados no existe.')
      if (e.code === 'P2034') return make('RESOURCE_CONFLICT', 409, 'Conflicto de concurrencia', 'Otra operación modificó los mismos datos. Reintente.')
    }
    if (e instanceof HttpException) {
      const status = e.getStatus()
      if (status === HttpStatus.NOT_FOUND) return make('NOT_FOUND', 404, 'Ruta inexistente', 'El recurso solicitado no existe en esta versión de la API.')
      if (status === HttpStatus.UNAUTHORIZED) return make('UNAUTHENTICATED', 401, 'No autenticado')
      if (status === HttpStatus.FORBIDDEN) return make('FORBIDDEN', 403, 'Acción no permitida')
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) return make('VALIDATION_ERROR', 413, 'Solicitud demasiado grande')
      if (status < 500) return make('VALIDATION_ERROR', status, 'Solicitud inválida', typeof e.getResponse() === 'string' ? String(e.getResponse()) : undefined)
    }
    // Errores de Fastify (JSON mal formado, content-type, etc.).
    const fe = e as { statusCode?: number; code?: string } | null
    if (fe && typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      return make('VALIDATION_ERROR', fe.statusCode, 'Solicitud inválida', 'El cuerpo de la solicitud no es válido.')
    }
    return make('INTERNAL_ERROR', 500, 'Error del sistema', 'Ocurrió un error interno. Informe el código de referencia a soporte.')
  }
}
