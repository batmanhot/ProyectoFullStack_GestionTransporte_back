import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { CurrentPrincipal, Public, RequirePermission } from '../../common/decorators'
import { IdParam } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { FILE_MAX_BYTES, FILE_TYPES, FilesService } from './files.service'

class ReserveDto {
  @IsString() @Length(1, 200) name: string
  @IsInt() @Min(1) @Max(FILE_MAX_BYTES) size: number
  @IsIn(FILE_TYPES as unknown as string[]) type: string
}

const WRITERS = ['document.manage', 'incident.manage', 'alert.manage', 'driver.own_trip.execute'] as const
const READERS = ['document.manage', 'resource.eligibility.view', 'vehicle.manage', 'incident.manage', 'alert.manage'] as const

/** FE-CONTRACT-030 · ADR-009. */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @RequirePermission(...WRITERS)
  @ApiOperation({ summary: 'Reserva un archivo y devuelve una URL temporal de subida directa (10 min).' })
  reserve(@CurrentPrincipal() p: Principal, @Body() dto: ReserveDto) {
    return this.files.reserve(p, dto)
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission(...WRITERS)
  complete(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.files.complete(p, id)
  }

  @Get(':id/download-url')
  @RequirePermission(...READERS)
  @ApiOperation({ summary: 'URL temporal de vista/descarga (5 min). El acceso queda auditado.' })
  downloadUrl(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.files.downloadUrl(p, id)
  }

  /** Emulación local del almacenamiento (adaptador `local`): la autorización es el token firmado de la URL. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Put('blob/:token')
  @HttpCode(200)
  async putBlob(@Param('token') token: string, @Headers('content-type') ct: string | undefined, @Req() req: FastifyRequest) {
    await this.files.receiveBlob(token, ct, req.body)
    return { ok: true }
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('blob/:token')
  async getBlob(@Param('token') token: string, @Res() reply: FastifyReply) {
    const f = await this.files.serveBlob(token)
    reply
      .header('Content-Type', f.type)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(f.data)
  }
}
