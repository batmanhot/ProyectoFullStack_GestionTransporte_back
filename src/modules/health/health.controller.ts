import { Controller, Get, HttpCode, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { SkipThrottle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'
import { Public } from '../../common/decorators'
import { PrismaService } from '../../database/prisma.service'

/**
 * Health (prompt §30). Sin información sensible: ni versión de dependencias, ni host, ni datos de negocio.
 *  - /health        → liveness + dependencia crítica (BD).
 *  - /health/live   → el proceso responde.
 *  - /health/ready  → puede atender tráfico (BD disponible).
 */
@ApiTags('health')
@SkipThrottle()
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio y de la base de datos.' })
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const db = await this.prisma.ping()
    reply.status(db ? 200 : 503)
    return { status: db ? 'ok' : 'degraded', checks: { database: db ? 'up' : 'down' }, at: new Date().toISOString() }
  }

  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' }
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const db = await this.prisma.ping()
    reply.status(db ? 200 : 503)
    return { status: db ? 'ready' : 'not-ready' }
  }
}
