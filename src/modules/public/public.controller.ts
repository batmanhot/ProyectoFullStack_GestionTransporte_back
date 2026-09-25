import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator'
import { Public } from '../../common/decorators'
import { IdParam, isUuid } from '../../common/http/params'
import { Errors } from '../../common/errors/app-error'
import { PublicService } from './public.service'

class FindBookingDto {
  @IsIn(['DNI', 'CE', 'Pasaporte']) documentType: string
  @IsString() @Length(5, 20) document: string
  @IsString() @Length(2, 80) lastNamePaternal: string
}
class CancelBookingDto extends FindBookingDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string
}

/** Sin sesión (PC-A17/PC-A20). Límite por IP más estricto: 60/min (SUPUESTO TÉCNICO). */
@ApiTags('public')
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('public')
export class PublicController {
  constructor(private readonly pub: PublicService) {}

  @Get('settings/quick-access')
  @ApiOperation({ summary: 'Solo el flag de tarjetas de acceso rápido del Login (nunca días de gracia ni nada operativo).' })
  quickAccess() {
    return this.pub.quickAccessCardsEnabled()
  }

  @Get('terminals')
  terminals() {
    return this.pub.terminals()
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Cartelera de salidas/llegadas de una terminal para un día local (AAAA-MM-DD).' })
  schedule(@Query('baseId') baseId: string, @Query('date') date: string) {
    if (!isUuid(baseId)) throw Errors.field('baseId', 'Terminal inválida.')
    return this.pub.schedule(baseId.toLowerCase(), date ?? '')
  }

  @Post('passenger-bookings/find')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Busca reservas por documento + apellido paterno (POST para no dejar el documento en logs de URL).' })
  find(@Body() dto: FindBookingDto) {
    return this.pub.findBookings(dto)
  }

  @Post('passenger-bookings/:id/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  cancel(@IdParam() id: string, @Body() dto: CancelBookingDto) {
    return this.pub.cancelBooking(id, dto)
  }
}
