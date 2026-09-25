import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common'
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator'
import { CurrentPrincipal, RequirePermission } from '../../common/decorators'
import type { Principal } from '../access/domain/principal'
import { DriverService } from './driver.service'

class ChecklistItemDto {
  @IsString() @Length(1, 20) itemId: string
  @IsBoolean() ok: boolean
  @IsOptional() @IsString() @MaxLength(300) note?: string
}
class DriverIncidentDto {
  @IsString() @Length(2, 20) category: string
  @IsString() @Length(1, 2000) description: string
  @IsBoolean() emergency: boolean
}
class DriverMessageDto {
  @IsString() @Length(1, 1000) text: string
}
class PayloadDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) checklist?: ChecklistItemDto[]
  @IsOptional() @ValidateNested() @Type(() => DriverIncidentDto) incident?: DriverIncidentDto
  @IsOptional() @ValidateNested() @Type(() => DriverMessageDto) message?: DriverMessageDto
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) evidenceNames?: string[]
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) evidenceFileIds?: string[]
  @IsOptional() @IsString() @MaxLength(500) note?: string
}
class DriverActionDto {
  @IsUUID() tripId: string
  @IsIn(['checklist', 'start', 'incident', 'arrival', 'finish', 'message']) type: 'checklist' | 'start' | 'incident' | 'arrival' | 'finish' | 'message'
  @IsISO8601() occurredAt: string
  @ValidateNested() @Type(() => PayloadDto) payload: PayloadDto
}

/** FE-CONTRACT-011 · RF-027/028 · FE-040. */
@ApiTags('driver')
@Controller('driver')
@RequirePermission('driver.own_trip.execute')
export class DriverController {
  constructor(private readonly driver: DriverService) {}

  @Get('trips')
  @ApiOperation({ summary: 'Mis viajes (asignado → en destino), con checklist y vencimiento de la copia offline.' })
  myTrips(@CurrentPrincipal() p: Principal) {
    return this.driver.myTrips(p)
  }

  @Post('actions')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Acción del outbox offline. Respuesta Confirmada | Rechazada (definitiva, con motivo).' })
  submit(@CurrentPrincipal() p: Principal, @Headers('idempotency-key') key: string | undefined, @Body() dto: DriverActionDto) {
    return this.driver.submit(p, key, dto)
  }
}
