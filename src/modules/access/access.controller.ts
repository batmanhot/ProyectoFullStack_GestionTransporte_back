import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import { ChangePasswordDto, CreateOrgUnitDto, CreateUserDto, UpdateOrgUnitDto, UpdateUserDto } from './access.dto'
import { AccessService } from './access.service'
import type { Principal } from './domain/principal'

/** FE-CONTRACT-002 · FE-060/061 · RF-002/032. */
@ApiTags('access')
@Controller()
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('users')
  @RequirePermission('tenant.user.manage')
  @ApiOperation({ summary: 'Usuarios del negocio (página + facetas por estado, acceso y rol).' })
  listUsers(@RawQueryParams() q: RawQuery) {
    return this.access.listUsers(q)
  }

  @Post('users')
  @Idempotent()
  @RequirePermission('tenant.user.manage')
  @ApiOperation({ summary: 'Crea un usuario del negocio. Devuelve una contraseña temporal UNA sola vez.' })
  createUser(@CurrentPrincipal() p: Principal, @Body() dto: CreateUserDto) {
    return this.access.createUser(p, dto)
  }

  @Patch('users/:id')
  @RequirePermission('tenant.user.manage')
  @ApiOperation({ summary: 'Cambia roles, alcance o estado (Activo/Inactivo/Bloqueado) de un usuario. Nunca se borra.' })
  updateUser(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: UpdateUserDto) {
    return this.access.updateUser(p, id, dto)
  }

  @Get('org-units')
  @ApiOperation({ summary: 'Estructura del negocio con uso (vehículos, conductores, usuarios).' })
  listOrgUnits() {
    return this.access.listOrgUnits()
  }

  @Post('org-units')
  @Idempotent()
  @RequirePermission('organization.configure')
  createOrgUnit(@CurrentPrincipal() p: Principal, @Body() dto: CreateOrgUnitDto) {
    return this.access.createOrgUnit(p, dto)
  }

  @Patch('org-units/:id')
  @RequirePermission('organization.configure')
  updateOrgUnit(@IdParam() id: string, @Body() dto: UpdateOrgUnitDto) {
    return this.access.updateOrgUnit(id, dto)
  }

  @Get('roles/matrix')
  @RequirePermission('tenant.user.manage')
  @ApiOperation({ summary: 'Matriz rol→permiso vigente (solo lectura, sin ROL-001).' })
  roleMatrix() {
    return this.access.roleMatrix()
  }

  @Get('lookups/org')
  @ApiOperation({ summary: 'Flotas y terminales activas para los selectores.' })
  lookups() {
    return this.access.lookups()
  }

  @Post('me/password')
  @HttpCode(204)
  @ApiOperation({ summary: 'PROPUESTA: cambio de contraseña propia (cierra las otras sesiones).' })
  async changePassword(@CurrentPrincipal() p: Principal, @Body() dto: ChangePasswordDto) {
    await this.access.changePassword(p, dto.currentPassword, dto.newPassword)
  }
}
