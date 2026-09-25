import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { PassengersService } from './passengers.service'

class PassengerDto {
  @IsIn(['DNI', 'CE', 'Pasaporte']) documentType: string
  @IsString() @Length(5, 20) document: string
  @IsString() @Length(2, 80) lastNamePaternal: string
  @IsString() @MaxLength(80) lastNameMaternal: string
  @IsString() @Length(2, 120) firstNames: string
  @IsString() @MaxLength(30) phone: string
  @IsBoolean() reducedMobility: boolean
  @IsUUID() tripId: string
  @IsString() @Length(1, 80) boardStop: string
  @IsString() @Length(1, 80) alightStop: string
  @IsOptional() @IsInt() @Min(1) @Max(120) seat: number | null
}
class PassengerUpdateDto {
  @IsString() @Length(2, 80) lastNamePaternal: string
  @IsString() @MaxLength(80) lastNameMaternal: string
  @IsString() @Length(2, 120) firstNames: string
  @IsString() @MaxLength(30) phone: string
  @IsBoolean() reducedMobility: boolean
  @IsInt() @Min(1) @Max(120) seat: number
}
class AdvanceDto {
  @IsIn(['Reservada', 'Abordó', 'Llegó a destino', 'No se presentó', 'Cancelada']) to: string
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class CancelDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}

/** Pasajeros (Fase 2 · RF-025/026 · PC-A6) y portal propio (Fase 3 · PC-A9). */
@ApiTags('passengers')
@Controller()
export class PassengersController {
  constructor(private readonly pax: PassengersService) {}

  @Get('passenger-bookings')
  @RequirePermission('passenger.manage')
  list(@RawQueryParams() q: RawQuery) {
    return this.pax.list(q)
  }

  @Get('passenger-bookings/assignable-trips')
  @RequirePermission('passenger.manage')
  assignableTrips() {
    return this.pax.assignableTrips()
  }

  @Post('passenger-bookings')
  @Idempotent()
  @RequirePermission('passenger.manage')
  create(@CurrentPrincipal() p: Principal, @Body() dto: PassengerDto) {
    return this.pax.create(p, dto)
  }

  @Patch('passenger-bookings/:id')
  @RequirePermission('passenger.manage')
  update(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: PassengerUpdateDto) {
    return this.pax.update(p, id, dto)
  }

  @Post('passenger-bookings/:id/advance')
  @HttpCode(200)
  @RequirePermission('passenger.manage')
  advance(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AdvanceDto) {
    return this.pax.advance(p, id, dto)
  }

  @Get('trips/:id/manifest')
  @RequirePermission('passenger.manage')
  manifest(@IdParam() id: string) {
    return this.pax.manifest(id)
  }

  @Get('passengers/lookup')
  @RequirePermission('passenger.manage')
  lookup(@Query('documentType') documentType: string, @Query('document') document: string) {
    return this.pax.lookup(documentType, document ?? '')
  }

  @Get('me/bookings')
  @RequirePermission('passenger.portal')
  mine(@CurrentPrincipal() p: Principal) {
    return this.pax.mine(p)
  }

  @Post('me/bookings/:id/cancel')
  @HttpCode(200)
  @RequirePermission('passenger.portal')
  cancelMine(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: CancelDto) {
    return this.pax.cancelMine(p, id, dto.reason)
  }
}
