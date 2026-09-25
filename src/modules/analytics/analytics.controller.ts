import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentPrincipal, RequirePermission } from '../../common/decorators'
import { IdParam, isUuid } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { notificationView } from '../notifications/notification.service'
import { AnalyticsService } from './analytics.service'

/** FE-CONTRACT-009 (KPI) y panel (FE-002). */
@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('kpis')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'KPI-001…011 con fórmula, período, corte y tendencia real. Sin metas inventadas (target = null).' })
  kpis(@CurrentPrincipal() p: Principal, @Query('period') period: string, @Query('baseId') baseId?: string) {
    return this.analytics.kpis(p, period ?? '7d', baseId && isUuid(baseId) ? baseId.toLowerCase() : undefined)
  }

  @Get('dashboard/overview')
  @RequirePermission('audit.view')
  overview(@CurrentPrincipal() p: Principal, @Query('period') period: string) {
    return this.analytics.overview(p, period ?? '7d')
  }
}

/** FE-CONTRACT-010 · ADR-010: bandeja in-app con estado de entrega por canal. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal) {
    // Cuentas de plataforma y pasajeros (solo portal) no reciben las notificaciones operativas del negocio.
    if (!p.tenantId || p.permissions.every((x) => x === 'passenger.portal')) return []
    const rows = await this.prisma.db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { deliveries: true } })
    return rows.map(notificationView)
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    if (!p.tenantId) return
    await this.prisma.db.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } })
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@CurrentPrincipal() p: Principal) {
    if (!p.tenantId) return
    await this.prisma.db.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } })
  }
}
