import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import {
  AdvanceMaintenanceDto, DocumentDto, DriverActiveDto, DriverDto, MaintenanceDto, ReasonDto, UpdateDriverDto, UpdateMaintenanceDto, UpdateVehicleDto, VehicleDto, VehicleServiceDto,
} from './fleet.dto'
import { FleetService } from './fleet.service'

/** FE-CONTRACT-003 · FE-010–013 · RF-003–007. */
@ApiTags('fleet')
@Controller()
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('vehicles')
  @RequirePermission('vehicle.manage', 'resource.eligibility.view', 'trip.create')
  @ApiOperation({ summary: 'Vehículos del alcance con elegibilidad, condiciones y lifecycle calculados por el servidor.' })
  listVehicles(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.fleet.listVehicles(p, q)
  }

  @Post('vehicles')
  @Idempotent()
  @RequirePermission('vehicle.manage')
  createVehicle(@CurrentPrincipal() p: Principal, @Body() dto: VehicleDto) {
    return this.fleet.createVehicle(p, dto)
  }

  @Patch('vehicles/:id')
  @RequirePermission('vehicle.manage')
  @ApiOperation({ summary: 'Actualización parcial con versión optimista (409 si cambió). Odómetro nunca retrocede (EXC-003).' })
  updateVehicle(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: UpdateVehicleDto) {
    return this.fleet.updateVehicle(p, id, dto)
  }

  @Post('vehicles/:id/block')
  @HttpCode(200)
  @RequirePermission('maintenance.manage')
  block(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: ReasonDto) {
    return this.fleet.blockVehicle(p, id, dto.reason)
  }

  @Post('vehicles/:id/unblock')
  @HttpCode(200)
  @RequirePermission('maintenance.manage')
  @ApiOperation({ summary: 'Libera un bloqueo (CTRL-024). SOD-002: quien bloqueó no libera sin revisión.' })
  unblock(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: ReasonDto) {
    return this.fleet.unblockVehicle(p, id, dto.reason)
  }

  @Post('vehicles/:id/service')
  @HttpCode(200)
  @RequirePermission('vehicle.manage')
  @ApiOperation({ summary: 'Baja / reincorporación de servicio (baja lógica, con motivo).' })
  service(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: VehicleServiceDto) {
    return this.fleet.setVehicleService(p, id, dto.inService, dto.reason)
  }

  @Get('drivers')
  @RequirePermission('driver.manage', 'resource.eligibility.view', 'trip.create')
  listDrivers(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.fleet.listDrivers(p, q)
  }

  @Post('drivers')
  @Idempotent()
  @RequirePermission('driver.manage')
  createDriver(@CurrentPrincipal() p: Principal, @Body() dto: DriverDto) {
    return this.fleet.createDriver(p, dto)
  }

  @Patch('drivers/:id')
  @RequirePermission('driver.manage')
  updateDriver(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: UpdateDriverDto) {
    return this.fleet.updateDriver(p, id, dto)
  }

  @Post('drivers/:id/active')
  @HttpCode(200)
  @RequirePermission('driver.manage')
  setDriverActive(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: DriverActiveDto) {
    return this.fleet.setDriverActive(p, id, dto.active, dto.reason)
  }

  @Get('documents')
  @RequirePermission('document.manage', 'resource.eligibility.view', 'vehicle.manage')
  listDocuments(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.fleet.listDocuments(p, q)
  }

  @Post('documents')
  @Idempotent()
  @RequirePermission('document.manage')
  @ApiOperation({ summary: 'Registra o renueva un documento: el anterior del mismo tipo queda «Reemplazado» (RN-009).' })
  createDocument(@CurrentPrincipal() p: Principal, @Body() dto: DocumentDto) {
    return this.fleet.createDocument(p, dto)
  }

  @Get('maintenance-orders')
  @RequirePermission('maintenance.manage', 'vehicle.manage', 'resource.eligibility.view')
  listMaintenance(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.fleet.listMaintenance(p, q)
  }

  @Post('maintenance-orders')
  @Idempotent()
  @RequirePermission('maintenance.manage')
  createMaintenance(@CurrentPrincipal() p: Principal, @Body() dto: MaintenanceDto) {
    return this.fleet.createMaintenance(p, dto)
  }

  @Patch('maintenance-orders/:id')
  @RequirePermission('maintenance.manage')
  updateMaintenance(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: UpdateMaintenanceDto) {
    return this.fleet.updateMaintenance(p, id, dto)
  }

  @Post('maintenance-orders/:id/advance')
  @HttpCode(200)
  @RequirePermission('maintenance.manage')
  advanceMaintenance(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AdvanceMaintenanceDto) {
    return this.fleet.advanceMaintenance(p, id, dto)
  }
}
