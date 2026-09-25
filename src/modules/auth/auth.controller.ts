import '@fastify/cookie'
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { APP_CONFIG, authRateLimitFromEnv, type AppConfig } from '../../config/app-config'
import { CurrentPrincipal, Public } from '../../common/decorators'
import { Errors } from '../../common/errors/app-error'
import type { Principal } from '../access/domain/principal'
import { AuthService, type IssuedSession, type SessionView } from './auth.service'

/**
 * Límite de intentos de login por IP y minuto (política «auth», SUPUESTO TÉCNICO). Complementa el bloqueo por cuenta
 * (LOGIN_MAX_FAILED). Configurable: oficinas detrás de una sola IP pública pueden necesitar más holgura.
 */
const AUTH_LIMIT_PER_MIN = () => authRateLimitFromEnv()

export class LoginDto {
  /** Slug del negocio (PC-A22). Sin slug = acceso de plataforma (SuperAdmin). */
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{3,48}$/i, { message: 'El identificador de empresa no es válido.' })
  slug?: string

  @IsEmail({}, { message: 'Ingrese un correo válido.' }) @MaxLength(160)
  email: string

  @IsString() @Length(1, 128, { message: 'Ingrese la contraseña.' })
  password: string
}

/**
 * FE-CONTRACT-001 · ADR-003. El refresh token viaja SOLO en cookie httpOnly + Secure + SameSite=Strict, acotada a la
 * ruta de autenticación. Refresh y logout exigen la cabecera `X-Client-Version` (la envía el FE): obliga a un preflight
 * CORS y bloquea CSRF de formularios. Protección CSRF adicional queda a criterio de DOC-G-SEC.
 */
@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get cookiePath(): string {
    return `/${this.config.apiPrefix}/auth`
  }

  private setRefresh(reply: FastifyReply, s: IssuedSession): SessionView {
    reply.setCookie(this.config.auth.refreshCookieName, s.refreshToken, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: 'strict',
      path: this.cookiePath,
      expires: s.refreshExpiresAt,
    })
    reply.header('Cache-Control', 'no-store')
    return s.session
  }

  private clearRefresh(reply: FastifyReply): void {
    reply.clearCookie(this.config.auth.refreshCookieName, { path: this.cookiePath })
  }

  private requireClientHeader(req: FastifyRequest): void {
    if (!req.headers['x-client-version']) throw Errors.forbidden('Solicitud sin cabecera de cliente: rechazada por protección CSRF.')
  }

  @Public()
  @Throttle({ default: { limit: AUTH_LIMIT_PER_MIN, ttl: 60_000 } })
  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inicia sesión (slug de empresa + correo + contraseña). Devuelve access token y fija la cookie de refresh.' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply): Promise<SessionView> {
    return this.setRefresh(reply, await this.auth.login(dto))
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('auth/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rota el refresh token (cookie) y emite un nuevo access token.' })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<SessionView> {
    this.requireClientHeader(req)
    try {
      return this.setRefresh(reply, await this.auth.refresh(req.cookies[this.config.auth.refreshCookieName]))
    } catch (e) {
      this.clearRefresh(reply)
      throw e
    }
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cierra la sesión: revoca la familia de refresh y borra la cookie.' })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    this.requireClientHeader(req)
    await this.auth.logout(req.cookies[this.config.auth.refreshCookieName])
    this.clearRefresh(reply)
  }

  @Get('me/subscription-notice')
  @ApiOperation({ summary: 'Aviso comercial del negocio de la sesión (Por vencer / En gracia). null si no requiere atención.' })
  async notice(@CurrentPrincipal() p: Principal) {
    return (await this.auth.noticeFor(p)) ?? null
  }
}
