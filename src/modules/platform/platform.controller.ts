import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards, type CanActivate } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator'
import { RequestContext } from '../../common/context/request-context'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { Errors } from '../../common/errors/app-error'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { PlatformGovernanceService } from './platform-governance.service'
import { PlatformTenantsService } from './platform-tenants.service'

/** Defensa en profundidad: además del permiso, la cuenta debe ser DE PLATAFORMA (sin tenant). */
class PlatformAccountGuard implements CanActivate {
  canActivate(): boolean {
    const p = RequestContext.principal()
    if (!p || p.kind !== 'platform' || p.tenantId !== null) throw Errors.forbidden('Solo cuentas de plataforma.')
    return true
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
class SubscriptionDto {
  @IsIn(['Starter', 'Business', 'Enterprise']) plan: string
  @Matches(DATE) startsAt: string
  @Matches(DATE) endsAt: string
}
class AdminSeedDto {
  @IsString() @Length(3, 120) name: string
  @IsEmail() email: string
  @IsString() @Length(8, 128) initialPassword: string
}
class AdministratorsDto {
  @ValidateNested() @Type(() => AdminSeedDto) owner: AdminSeedDto
  @ValidateNested() @Type(() => AdminSeedDto) tenant: AdminSeedDto
}
class CreateTenantDto {
  @IsString() @Length(3, 120) name: string
  @IsString() @Length(3, 48) slug: string
  @IsString() @Length(2, 60) timezone: string
  @IsEmail() adminContact: string
  @ValidateNested() @Type(() => SubscriptionDto) commercialSubscription: SubscriptionDto
  @ValidateNested() @Type(() => AdministratorsDto) administrators: AdministratorsDto
}
class UpdateTenantDto {
  @IsString() @Length(3, 120) name: string
  @IsString() @Length(2, 60) timezone: string
  @IsEmail() adminContact: string
}
class RenewDto extends SubscriptionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class DeploymentDto {
  @IsIn(['SaaS compartido', 'Nube privada gestionada', 'On-premise', 'Híbrido']) mode: string
  @IsString() @Length(1, 60) version: string
  @IsString() @Length(8, 200) capacityContract: string
  @IsEmail() technicalContact: string
  @IsIn(['Soporte estándar', 'Soporte prioritario', 'SLA Enterprise']) supportChannel: string
  @IsBoolean() monitoringAuthorized: boolean
  @IsIn(['Vigente', 'Por renovar', 'Vencida']) licenseStatus: string
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class TransitionDto {
  @IsIn(['Borrador', 'Configurado', 'Activo', 'Suspendido', 'Reactivado', 'Cerrado']) to: string
  @IsString() @MinLength(10, { message: 'El motivo es obligatorio (mín. 10 caracteres).' }) @MaxLength(500) reason: string
}
class SupportDto {
  @IsUUID() tenantId: string
  @IsString() @Length(3, 60) caseRef: string
  @IsString() @Length(10, 500) reason: string
  @IsString() @Length(1, 120) scope: string
  @IsInt() @Min(1) @Max(8) hours: number
}
class PlatformAdminDto {
  @IsString() @Length(3, 120) name: string
  @IsEmail() email: string
}
class StatusDto {
  @IsBoolean() active: boolean
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class TenantAdminDto extends PlatformAdminDto {
  @IsIn(['ROL-002', 'ROL-015']) role: 'ROL-002' | 'ROL-015'
}
class BackupDto {
  @IsUUID() tenantId: string
}
class ReasonDto {
  @IsString() @MinLength(10) @MaxLength(500) reason: string
}
class RolePermsDto {
  @IsArray() @IsString({ each: true }) permissions: string[]
}
class SettingsDto {
  @IsBoolean() quickAccessCardsEnabled: boolean
  @IsInt() @Min(0) @Max(60) graceDays: number
}

/** FE-CONTRACT-012/014/015 · RF-001 · PC-A1 · Consola SuperAdmin. */
@ApiTags('platform')
@Controller('platform')
@RequirePermission('platform.tenant.manage')
@UseGuards(PlatformAccountGuard)
export class PlatformController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly gov: PlatformGovernanceService,
  ) {}

  @Get('tenants')
  listTenants(@RawQueryParams() q: RawQuery) {
    return this.tenants.list(q)
  }

  @Post('tenants')
  @Idempotent()
  @ApiOperation({ summary: 'Alta de negocio: suscripción + Admin Owner + Admin Tenant en una sola transacción.' })
  createTenant(@CurrentPrincipal() p: Principal, @Body() dto: CreateTenantDto) {
    return this.tenants.create(p, dto)
  }

  @Patch('tenants/:id')
  updateTenant(@IdParam() id: string, @Body() dto: UpdateTenantDto) {
    return this.tenants.update(id, dto)
  }

  @Patch('tenants/:id/deployment')
  updateDeployment(@IdParam() id: string, @Body() dto: DeploymentDto) {
    return this.tenants.updateDeployment(id, dto)
  }

  @Patch('tenants/:id/subscription')
  @ApiOperation({ summary: 'Renueva o cambia de plan: reemplaza la vigencia (historial conservado, auditado).' })
  renew(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: RenewDto) {
    return this.tenants.renew(p, id, dto)
  }

  @Post('tenants/:id/transition')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activar / suspender / reactivar. «Cerrar» bloqueado hasta política de retención (GAP-003).' })
  transition(@IdParam() id: string, @Body() dto: TransitionDto) {
    return this.tenants.transition(id, dto.to, dto.reason)
  }

  @Post('tenants/:id/admins')
  @Idempotent()
  assignTenantAdmin(@IdParam() id: string, @Body() dto: TenantAdminDto) {
    return this.gov.assignTenantAdmin(id, dto)
  }

  @Get('tenant-admins')
  listSlots(@RawQueryParams() q: RawQuery) {
    return this.gov.listSlots(q)
  }

  @Post('tenant-admins/:id/status')
  @HttpCode(200)
  setTenantAdmin(@IdParam() id: string, @Body() dto: StatusDto) {
    return this.gov.setTenantAdminActive(id, dto.active, dto.reason)
  }

  @Get('health')
  health() {
    return this.gov.health()
  }

  @Get('overview')
  overview() {
    return this.gov.overview()
  }

  @Get('alerts')
  alerts() {
    return this.gov.alertCenter()
  }

  @Post('alerts/recalculate')
  @HttpCode(200)
  recalculate() {
    return this.gov.recalculate()
  }

  @Post('alerts/:id/:action')
  @HttpCode(200)
  alertStatus(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('action') action: string) {
    if (action !== 'resolve' && action !== 'silence') throw Errors.notFound('Acción desconocida.')
    if (!/^[a-z0-9-]{3,80}$/i.test(id)) throw Errors.unavailable()
    return this.gov.setAlertStatus(p, id, action === 'resolve' ? 'Resuelta' : 'Silenciada')
  }

  @Get('support-sessions')
  listSupport() {
    return this.gov.listSupport()
  }

  @Get('support-sessions/interactions')
  interactions() {
    return this.gov.listInteractions()
  }

  @Post('support-sessions')
  @ApiOperation({ summary: 'SOD-003: acceso de soporte por caso + motivo + alcance, máx. 8 h, auditado en plataforma y en el negocio.' })
  openSupport(@CurrentPrincipal() p: Principal, @Body() dto: SupportDto) {
    return this.gov.openSupport(p, dto)
  }

  @Get('support-sessions/:id/diagnostics')
  diagnostics(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.gov.diagnostics(p, id)
  }

  @Post('support-sessions/:id/exit')
  @HttpCode(204)
  async exit(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    await this.gov.recordExit(p, id)
  }

  @Post('support-sessions/:id/revoke')
  @HttpCode(200)
  revoke(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.gov.revokeSupport(p, id)
  }

  @Get('admins')
  listAdmins() {
    return this.gov.listAdmins()
  }

  @Post('admins')
  @Idempotent()
  @ApiOperation({ summary: 'Crea un SuperAdmin Delegado (solo el Nativo; máx. 2). Devuelve la contraseña temporal una sola vez.' })
  createAdmin(@CurrentPrincipal() p: Principal, @Body() dto: PlatformAdminDto) {
    return this.gov.createAdmin(p, dto)
  }

  @Patch('admins/:id')
  updateAdmin(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: PlatformAdminDto) {
    return this.gov.updateAdmin(p, id, dto)
  }

  @Post('admins/:id/status')
  @HttpCode(200)
  setAdmin(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: StatusDto) {
    return this.gov.setAdminActive(p, id, dto.active, dto.reason)
  }

  @Get('backups')
  listBackups(@RawQueryParams() q: RawQuery) {
    return this.gov.listBackups(q)
  }

  @Post('backups')
  @ApiOperation({ summary: 'PENDIENTE DOC-I-OPS: responde EXTERNAL_DEPENDENCY_UNAVAILABLE sin modificar datos.' })
  createBackup(@Body() _dto: BackupDto) {
    return this.gov.backupUnavailable()
  }

  @Post('backups/:id/restore')
  @HttpCode(200)
  restoreBackup(@IdParam() _id: string, @Body() _dto: ReasonDto) {
    return this.gov.backupUnavailable()
  }

  @Get('roles')
  roles() {
    return this.gov.roleMatrix()
  }

  @Patch('roles/:role')
  updateRole(@Param('role') role: string, @Body() dto: RolePermsDto) {
    return this.gov.updateRole(role, dto.permissions)
  }

  @Post('roles/:role/reset')
  @HttpCode(200)
  resetRole(@Param('role') role: string) {
    return this.gov.resetRole(role)
  }

  @Get('settings')
  settings() {
    return this.gov.getSettings()
  }

  @Patch('settings')
  updateSettings(@Body() dto: SettingsDto) {
    return this.gov.updateSettings(dto)
  }
}
