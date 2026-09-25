import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { CargoService } from './cargo.service'

class CargoDto {
  @IsIn(['RUC', 'DNI']) documentType: 'RUC' | 'DNI'
  @IsString() @Length(8, 11) document: string
  @IsString() @Length(2, 160) customer: string
  @IsString() @Length(2, 80) cargoType: string
  @IsString() @Length(5, 500, { message: 'Describa la carga (mín. 5 caracteres).' }) description: string
  @IsInt() @Min(1) @Max(100_000) packages: number
  @IsNumber() @Min(0.01) @Max(80_000) weightKg: number
  @IsString() @Length(2, 120) origin: string
  @IsString() @Length(2, 120) destination: string
  @IsISO8601() promisedAt: string
}
class AssignDto {
  @IsUUID() tripId: string
}
class AdvanceDto {
  @IsIn(['Registrada', 'Asignada', 'En tránsito', 'Entregada', 'Con excepción', 'Cancelada']) to: string
  @IsOptional() @IsString() @MaxLength(500) reason?: string
  @IsOptional() @IsString() @MaxLength(120) receivedBy?: string
}

/** Carga (Fase 2 · RF-023/024 · PC-A11). */
@ApiTags('cargo')
@Controller('cargo-shipments')
@RequirePermission('cargo.manage')
export class CargoController {
  constructor(private readonly cargo: CargoService) {}

  @Get()
  list(@RawQueryParams() q: RawQuery) {
    return this.cargo.list(q)
  }

  @Get('assignable-trips')
  assignableTrips() {
    return this.cargo.assignableTrips()
  }

  @Post()
  @Idempotent()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CargoDto) {
    return this.cargo.create(p, dto)
  }

  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: CargoDto) {
    return this.cargo.update(p, id, dto)
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AssignDto) {
    return this.cargo.assign(p, id, dto.tripId)
  }

  @Post(':id/advance')
  @HttpCode(200)
  advance(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AdvanceDto) {
    return this.cargo.advance(p, id, dto)
  }
}
