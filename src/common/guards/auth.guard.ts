import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'
import { RequestContext } from '../context/request-context'
import { Errors } from '../errors/app-error'
import { IS_PUBLIC } from '../decorators'
import { PrincipalLoader } from '../../modules/auth/principal.loader'
import { TokenService } from '../../modules/auth/token.service'

export const bearerFrom = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return null
  const t = h.slice(7).trim()
  return t || null
}

/**
 * Guard global de AUTENTICACIÓN (deny by default): todo endpoint exige sesión salvo @Public().
 * Carga el principal desde la BD y fija el tenant del contexto a partir de la SESIÓN (nunca de una cabecera).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalLoader,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true
    const req = ctx.switchToHttp().getRequest<FastifyRequest>()
    const token = bearerFrom(req)
    if (!token) throw Errors.unauthenticated()
    const claims = await this.tokens.verifyAccess(token)
    const principal = await this.principals.load(claims.sub, claims.sid)
    RequestContext.setPrincipal(principal)
    return true
  }
}
