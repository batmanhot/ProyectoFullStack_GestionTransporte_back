import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RequestContext } from '../context/request-context'
import { Errors } from '../errors/app-error'
import { REQUIRED_PERMS } from '../decorators'
import type { Permission } from '../../modules/access/domain/catalog'
import { AuditService } from '../../modules/audit/audit.service'

/**
 * Guard global de AUTORIZACIÓN por permiso (DOC-A §J). Cada denegación queda auditada como evento de Seguridad
 * (`access.denied`) con el permiso requerido: base de la faceta «denegaciones» de la auditoría.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMS, [ctx.getHandler(), ctx.getClass()])
    if (!required?.length) return true
    const p = RequestContext.principal()
    if (!p) throw Errors.unauthenticated()
    if (required.some((perm) => p.permissions.includes(perm))) return true
    await this.audit.recordSafe({
      kind: 'Seguridad',
      resourceType: 'Autorización',
      resourceId: required[0] ?? '-',
      action: 'access.denied',
      result: 'DENEGADO',
      after: `Permiso requerido: ${required.join(' | ')}`,
    })
    throw Errors.forbidden('Su rol no incluye el permiso requerido para esta acción. Solicite acceso a su administrador.')
  }
}
