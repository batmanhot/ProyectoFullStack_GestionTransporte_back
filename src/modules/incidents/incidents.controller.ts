import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { IncidentsService } from './incidents.service'

const CATEGORIES = ['Avería', 'Accidente', 'Retraso', 'Bloqueo', 'Mecánica', 'Seguridad', 'Carga', 'Pasajero']

class IncidentDto {
  @IsOptional() @IsUUID() tripId: string | null
  @IsOptional() @IsIn(CATEGORIES) category: string | null
  @IsIn(['Informativa', 'Baja', 'Media', 'Alta', 'Crítica']) severity: string
  @IsBoolean() emergency: boolean
  @IsString() @Length(10, 2000, { message: 'Describa lo ocurrido (mín. 10 caracteres).' }) description: string
  @IsOptional() @IsUUID() originAlertId?: string | null
}
class ActionDto {
  @IsString() @Length(1, 1000) text: string
}
class AdvanceDto {
  @IsIn(['Nueva', 'Clasificada', 'En atención', 'Contenida', 'Resuelta', 'Cerrada']) to: string
  @IsOptional() @IsIn(CATEGORIES) category?: string
  @IsOptional() @IsString() @MaxLength(2000) resolution?: string
  @IsOptional() @IsString() @MaxLength(2000) continuityPlan?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) evidenceNames?: string[]
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) evidenceFileIds?: string[]
}

/** FE-CONTRACT-007 · RF-021/022 · FE-032. */
@ApiTags('incidents')
@Controller('incidents')
@RequirePermission('incident.manage')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.incidents.list(p, q)
  }

  @Post()
  @Idempotent()
  create(@CurrentPrincipal() p: Principal, @Body() dto: IncidentDto) {
    return this.incidents.create(p, dto)
  }

  @Post(':id/actions')
  @HttpCode(200)
  addAction(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: ActionDto) {
    return this.incidents.addAction(p, id, dto.text)
  }

  @Post(':id/advance')
  @HttpCode(200)
  advance(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AdvanceDto) {
    return this.incidents.advance(p, id, dto)
  }
}
