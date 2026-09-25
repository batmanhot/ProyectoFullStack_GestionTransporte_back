import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'
import { RequestContext } from '../context/request-context'

/**
 * Rate limiting (prompt §31). Autenticado ⇒ por usuario; anónimo ⇒ por IP. Los límites por política
 * (auth, público, exportación, integración) se fijan con @Throttle en cada endpoint; valores = SUPUESTO TÉCNICO (§X).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const p = RequestContext.principal()
    if (p) return `user:${p.userId}`
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown'
    return `ip:${ip}`
  }
}
