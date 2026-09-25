import { Module } from '@nestjs/common'
import { FleetModule } from '../fleet/fleet.module'
import { MastersModule } from '../masters/masters.module'
import { MessagesService } from './messages.service'
import { PlanningController } from './planning.controller'
import { RoutesService } from './routes.service'
import { ServicesService } from './services.service'
import { TripReadModel } from './trip.read-model'
import { TripsService } from './trips.service'

@Module({
  imports: [FleetModule, MastersModule],
  controllers: [PlanningController],
  providers: [RoutesService, TripsService, TripReadModel, ServicesService, MessagesService],
  exports: [TripsService, TripReadModel, MessagesService, RoutesService],
})
export class PlanningModule {}
