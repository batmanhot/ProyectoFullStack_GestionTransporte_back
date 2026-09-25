import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { Errors } from '../../common/errors/app-error'
import { TENANT_LIFECYCLE } from '../../common/labels'
import { PrismaService } from '../../database/prisma.service'
import { isRoleId, SCOPE_TYPES, type ScopeType } from '../access/domain/catalog'
import type { Principal, ScopeRef } from '../access/domain/principal'
import { RoleMatrixService } from '../access/role-matrix.service'
import { PlatformSettingsReader } from '../platform/platform-settings.reader'
import { blockedDetail, OPERABLE_LIFECYCLES, subscriptionNotice } from '../platform/domain/subscription.policy'

/**
 * Reconstruye el principal en CADA petición autenticada (ADR-004). Así, sin esperar a que venza el access token:
 *  - un logout o revocación de sesión corta el acceso (la familia de refresh debe seguir viva);
 *  - una cuenta desactivada/bloqueada pierde el acceso;
 *  - un negocio suspendido o con la gracia vencida recibe TENANT_CONTEXT_INVALID (EXC-002, PC-A1 Fase 4);
 *  - un cambio de roles o de la matriz de permisos aplica en la siguiente petición.
 */
@Injectable()
export class PrincipalLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matrix: RoleMatrixService,
    private readonly settings: PlatformSettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async load(userId: string, sessionFamilyId: string): Promise<Principal> {
    const db = this.prisma.system // sin contexto de tenant todavía: el tenant sale de este mismo registro
    const [user, session] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, include: { roles: true, scopes: true, tenant: { include: { subscriptions: { where: { current: true }, take: 1 } } } } }),
      db.authSession.findFirst({ where: { familyId: sessionFamilyId, userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }),
    ])
    if (!user) throw Errors.unauthenticated()
    if (user.status !== 'ACTIVO') throw Errors.unauthenticated('Su cuenta está inactiva o bloqueada. Contacte al administrador.')
    const t = user.tenant
    if (user.tenantId) {
      if (!t) throw Errors.tenantInvalid('La organización de su sesión no existe.')
      if (!(OPERABLE_LIFECYCLES as readonly string[]).includes(t.lifecycle)) {
        throw Errors.tenantInvalid(t.lastChangeReason ?? 'La organización está suspendida. Sus datos se conservan.', { tenantStatus: TENANT_LIFECYCLE.label(t.lifecycle), tenantName: t.name })
      }
      const sub = t.subscriptions[0]
      if (sub) {
        const notice = subscriptionNotice(sub, t.name, await this.settings.graceDays())
        if (notice?.status === 'Bloqueada') throw Errors.tenantInvalid(blockedDetail(notice), { subscriptionExpired: true, tenantName: t.name })
      }
    }
    // La sesión se valida DESPUÉS del negocio: si una suspensión revocó las sesiones, el usuario ve el motivo real
    // (TENANT_CONTEXT_INVALID → pantalla de acceso restringido) en vez de un «sesión vencida» genérico.
    if (!session) throw Errors.unauthenticated()
    const roles = user.roles.map((r) => r.roleId).filter(isRoleId)
    const scopes: ScopeRef[] = user.scopes
      .filter((s): s is typeof s & { type: ScopeType } => (SCOPE_TYPES as readonly string[]).includes(s.type))
      .map((s) => ({ type: s.type, ...(s.refId ? { id: s.refId } : {}), label: s.label }))
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      kind: user.tenantId ? 'tenant' : 'platform',
      tenantId: user.tenantId,
      tenantName: t?.name ?? null,
      tenantStatus: t ? TENANT_LIFECYCLE.label(t.lifecycle) : undefined,
      timezone: t?.timezone ?? this.config.ops.defaultTimezone,
      roles,
      permissions: await this.matrix.permissionsOf(roles),
      scopes,
      isNative: user.isNative,
      document: user.document,
      sessionId: sessionFamilyId,
    }
  }
}
