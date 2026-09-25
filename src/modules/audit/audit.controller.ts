import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { IsBoolean, IsIn, IsInt, IsObject, IsString, Length, Max, Min } from 'class-validator'
import { CurrentPrincipal, RequirePermission } from '../../common/decorators'
import type { Principal } from '../access/domain/principal'
import { AuditQueryService } from './audit-query.service'

class ExportDto {
  @IsString() @Length(2, 80) resource: string
  @IsIn(['xlsx', 'pdf']) format: 'xlsx' | 'pdf'
  @IsObject() filters: Record<string, string>
  @IsInt() @Min(0) @Max(1_000_000) rowCount: number
  @IsBoolean() sensitive: boolean
}

/** FE-CONTRACT-008 · RF-029/031 · FE-050/073. */
@ApiTags('audit')
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get('audit-events')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Auditoría por CURSOR (keyset). La plataforma ve metadatos sin contenido de negocio (EXC-032).' })
  list(@CurrentPrincipal() p: Principal, @Query() q: { cursor?: string; pageSize?: string; search?: string; kind?: string; flag?: string }) {
    return this.audit.list(p, q)
  }

  @Get('audit-events/timeline')
  @RequirePermission('audit.view')
  timeline(@CurrentPrincipal() p: Principal, @Query('resourceType') resourceType: string, @Query('resourceId') resourceId: string) {
    return this.audit.timeline(p, resourceType, resourceId)
  }

  @Post('exports')
  @HttpCode(200)
  @RequirePermission('report.export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Autoriza y audita una exportación ANTES de generarla (POL-004 · CTRL-026).' })
  registerExport(@CurrentPrincipal() p: Principal, @Body() dto: ExportDto) {
    return this.audit.registerExport(p, dto)
  }
}
