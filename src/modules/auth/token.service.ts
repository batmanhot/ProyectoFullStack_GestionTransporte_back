import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { Errors } from '../../common/errors/app-error'

export interface AccessClaims {
  sub: string
  /** Familia de sesión de refresco: revocarla invalida también los access tokens emitidos con ella. */
  sid: string
  typ: 'access'
}

/**
 * Tokens (ADR-003): access token corto (JWT HS256, solo en memoria del cliente) + refresh token OPACO en cookie httpOnly,
 * guardado únicamente como hash SHA-256. Los TTL son configurables (no se hardcodea 15m/7d como norma).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async signAccess(userId: string, familyId: string): Promise<{ token: string; expiresAt: Date }> {
    const ttl = this.config.auth.accessTtlSeconds
    const claims: AccessClaims = { sub: userId, sid: familyId, typ: 'access' }
    const token = await this.jwt.signAsync(claims, { secret: this.config.auth.accessSecret, expiresIn: ttl, algorithm: 'HS256' })
    return { token, expiresAt: new Date(Date.now() + ttl * 1000) }
  }

  async verifyAccess(token: string): Promise<AccessClaims & { exp: number }> {
    try {
      const c = await this.jwt.verifyAsync<AccessClaims & { exp: number }>(token, { secret: this.config.auth.accessSecret, algorithms: ['HS256'] })
      if (c.typ !== 'access' || typeof c.sub !== 'string' || typeof c.sid !== 'string') throw new Error('claims')
      return c
    } catch {
      throw Errors.unauthenticated('Su sesión expiró. Ingrese nuevamente para continuar.')
    }
  }

  newRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url')
    return { token, hash: TokenService.hash(token), expiresAt: new Date(Date.now() + this.config.auth.refreshTtlDays * 86_400_000) }
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
}
