import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { Errors } from '../../common/errors/app-error'
import { IdParam, RawQueryParams, type RawQuery } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { ReasonDto } from '../fleet/fleet.dto'
import { TRIP_ACTION_RULES, type TripAction } from './domain/trip-rules'
import { MessagesService } from './messages.service'
import { AssignTripDto, MessageDto, RouteDto, ServiceDto, ServiceTransitionDto, TripActionDto, TripDto } from './planning.dto'
import { RoutesService } from './routes.service'
import { ServicesService } from './services.service'
import { TripsService } from './trips.service'

const TRIP_READERS = ['trip.create', 'trip.assign', 'trip.enable', 'trip.dispatch', 'tracking.view', 'driver.own_trip.execute', 'trip.cancel'] as const

/** FE-CONTRACT-004/005 · RF-008–014 · FE-020–022. */
@ApiTags('planning')
@Controller()
export class PlanningController {
  constructor(
    private readonly routes: RoutesService,
    private readonly trips: TripsService,
    private readonly services: ServicesService,
    private readonly messages: MessagesService,
  ) {}

  @Get('routes')
  @RequirePermission('route.manage', 'trip.create', 'trip.assign', 'tracking.view')
  listRoutes(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.routes.list(p, q)
  }

  @Post('routes')
  @Idempotent()
  @RequirePermission('route.manage')
  @ApiOperation({ summary: 'Crea una ruta o una NUEVA VERSIÓN (la anterior del mismo nombre queda «Obsoleta»).' })
  createRoute(@CurrentPrincipal() p: Principal, @Body() dto: RouteDto) {
    return this.routes.create(p, dto)
  }

  @Post('routes/:id/retire')
  @HttpCode(200)
  @RequirePermission('route.manage')
  retireRoute(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: ReasonDto) {
    return this.routes.retire(p, id, dto.reason)
  }

  @Get('trips')
  @RequirePermission(...TRIP_READERS)
  @ApiOperation({ summary: 'Viajes del alcance (paginación SQL, facetas por estado, prioridad, servicio y condición).' })
  listTrips(@CurrentPrincipal() p: Principal, @RawQueryParams() q: RawQuery) {
    return this.trips.list(p, q)
  }

  @Get('trips/:id')
  @RequirePermission(...TRIP_READERS)
  getTrip(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.trips.get(p, id)
  }

  @Post('trips')
  @Idempotent()
  @RequirePermission('trip.create')
  @ApiOperation({ summary: 'Planifica un viaje (RN-002 sin superposición; recursos elegibles; servicio vigente opcional).' })
  createTrip(@CurrentPrincipal() p: Principal, @Body() dto: TripDto) {
    return this.trips.create(p, dto)
  }

  @Post('trips/:id/assign')
  @HttpCode(200)
  @RequirePermission('trip.assign')
  assignTrip(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: AssignTripDto) {
    return this.trips.assign(p, id, dto)
  }

  @Get('trips/:id/gate')
  @RequirePermission(...TRIP_READERS)
  @ApiOperation({ summary: 'Evalúa el gate CTRL-001 y explica cada requisito (qué falla, quién corrige, qué regla).' })
  gate(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.trips.gate(p, id)
  }

  @Post('trips/:id/:action')
  @HttpCode(200)
  @Idempotent()
  @ApiParam({ name: 'action', enum: Object.keys(TRIP_ACTION_RULES) })
  @ApiOperation({ summary: 'Acción de lifecycle: enable | dispatch | arrival | close | cancel | interrupt | reassign | reschedule.' })
  act(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Param('action') action: string, @Body() dto: TripActionDto) {
    if (!(action in TRIP_ACTION_RULES)) throw Errors.notFound('Acción de viaje desconocida.')
    return this.trips.act(p, id, action as TripAction, dto)
  }

  @Get('trips/:id/messages')
  listMessages(@CurrentPrincipal() p: Principal, @IdParam() id: string) {
    return this.messages.list(p, id)
  }

  @Post('trips/:id/messages')
  @RequirePermission('dispatch.message')
  sendMessage(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: MessageDto) {
    return this.messages.send(p, id, dto.text)
  }

  @Get('services')
  @RequirePermission('service.manage', 'trip.create', 'trip.assign', 'trip.dispatch')
  listServices(@RawQueryParams() q: RawQuery) {
    return this.services.list(q)
  }

  @Post('services')
  @Idempotent()
  @RequirePermission('service.manage')
  createService(@CurrentPrincipal() p: Principal, @Body() dto: ServiceDto) {
    return this.services.create(p, dto)
  }

  @Patch('services/:id')
  @RequirePermission('service.manage')
  updateService(@CurrentPrincipal() p: Principal, @IdParam() id: string, @Body() dto: ServiceDto) {
    return this.services.update(p, id, dto)
  }

  @Post('services/:id/transition')
  @HttpCode(200)
  @RequirePermission('service.manage')
  transitionService(@IdParam() id: string, @Body() dto: ServiceTransitionDto) {
    return this.services.transition(id, dto.to, dto.reason)
  }
}
