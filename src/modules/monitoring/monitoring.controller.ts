import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common'
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import { CurrentPrincipal, Public, RequirePermission } from '../../common/decorators'
import { Errors } from '../../common/errors/app-error'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { isAlertAction, MonitoringService } from './monitoring.service'
import { TelemetryService } from './telemetry.service'

class AlertActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string
  @IsOptional() @IsString() @MaxLength(1000) evidence?: string
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) evidenceFileIds?: string[]
}

class TelemetryEventDto {
  @IsString() @Length(1, 60) deviceId: string
  @IsISO8601() sourceTime: string
  @IsNumber() @Min(-90) @Max(90) lat: number
  @IsNumber() @Min(-180) @Max(180) lon: number
  @IsOptional() @IsNumber() @Min(0) @Max(300) speedKmh?: number | null
  @IsOptional() @IsNumber() @Min(0) @Max(360) heading?: number | null
  @IsOptional() @IsBoolean() ignition?: boolean | null
  @IsOptional() @IsNumber() @Min(0) odometerKm?: number | null
}
class TelemetryBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => TelemetryEventDto) events: TelemetryEventDto[]
}

/** FE-CONTRACT-006 · RF-015–020 · FE-030/031 · INT-001. */
@ApiTags('monitoring')
@Controller()
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly telemetry: TelemetryService,
  ) {}

  @Get('tracking/positions')
  @RequirePermission('tracking.view')
  @ApiOperation({ summary: 'Última posición por vehículo del alcance, con frescura calculada por el servidor (RN-005).' })
  positions(@CurrentPrincipal() p: Principal) {
    return this.monitoring.positions(p)
  }

  @Get('tracking/summary')
  @RequirePermission('tracking.view')
  summary(@CurrentPrincipal() p: Principal) {
    return this.monitoring.summary(p)
  }

  @Get('alerts')
  @RequirePermission('alert.manage', 'document.manage')
  @ApiOperation({ summary: 'Bandeja de alertas (página, orden por severidad; facetas solo de alertas abiertas).' })
  listAlerts(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.monitoring.listAlerts(p, q)
  }

  @Post('alerts/:id/:action')
  @HttpCode(200)
  @RequirePermission('alert.manage', 'document.manage')
  @ApiOperation({ summary: 'acknowledge | manage | resolve | close (cierre de Alta/Crítica exige revisión senior).' })
  alertAction(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Param('action') action: string, @Body() dto: AlertActionDto) {
    if (!isAlertAction(action)) throw Errors.notFound('Acción de alerta desconocida.')
    return this.monitoring.alertAction(p, id, action, dto)
  }

  /** Ingesta de GPS/telemática (máquina a máquina). Autenticación por credencial de integración del negocio, no por sesión. */
  @Public()
  @Throttle({ default: { limit: 6000, ttl: 60_000 } })
  @Post('telemetry/positions')
  @HttpCode(202)
  @ApiHeader({ name: 'X-Integration-Key', required: true })
  @ApiOperation({ summary: 'Recibe lotes de posiciones (≤ 500) del adaptador del proveedor GPS. Idempotente por vehículo + instante.' })
  ingest(@Headers('x-integration-key') key: string | undefined, @Body() dto: TelemetryBatchDto) {
    return this.telemetry.ingest(key, dto.events)
  }
}
