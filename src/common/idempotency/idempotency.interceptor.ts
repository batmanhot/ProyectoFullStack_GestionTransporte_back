import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HTTP_CODE_METADATA } from '@nestjs/common/constants'
import { from, lastValueFrom, type Observable } from 'rxjs'
import { RequestContext } from '../context/request-context'
import { Errors } from '../errors/app-error'
import { IDEMPOTENT } from '../decorators'
import { IdempotencyService, requestHash } from './idempotency.service'

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/

/**
 * Aplica `Idempotency-Key` en los endpoints marcados con @Idempotent(). Sin cabecera, el endpoint funciona normal
 * (la clave es obligatoria solo donde el contrato lo exige: acciones del conductor).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idem: IdempotencyService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [ctx.getHandler(), ctx.getClass()])
    if (!enabled) return next.handle()
    const req = ctx.switchToHttp().getRequest<FastifyRequest>()
    const reply = ctx.switchToHttp().getResponse<FastifyReply>()
    const raw = req.headers['idempotency-key']
    const key = Array.isArray(raw) ? raw[0] : raw
    if (!key) return next.handle()
    if (!KEY_RE.test(key)) throw Errors.field('Idempotency-Key', 'La clave de idempotencia debe tener entre 8 y 128 caracteres alfanuméricos.')
    const p = RequestContext.principal()
    if (!p) throw Errors.unauthenticated()
    const scopeKey = this.idem.scopeKey(p.tenantId, p.userId, key)
    const hash = requestHash({ m: req.method, u: req.routeOptions.url ?? req.url, p: req.params ?? null, b: req.body ?? null })
    // Nest fija el código HTTP después del interceptor: se toma del @HttpCode del handler (o del default del método).
    const status = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, ctx.getHandler()) ?? (req.method === 'POST' ? 201 : 200)
    return from(this.run(scopeKey, hash, status, reply, next))
  }

  private async run(scopeKey: string, hash: string, status: number, reply: FastifyReply, next: CallHandler): Promise<unknown> {
    const begun = await this.idem.begin(scopeKey, hash)
    if ('replay' in begun) {
      reply.header('Idempotent-Replayed', 'true')
      return begun.replay.body
    }
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: null })
      await this.idem.complete(scopeKey, { status, body })
      return body
    } catch (e) {
      await this.idem.release(scopeKey)
      throw e
    }
  }
}
