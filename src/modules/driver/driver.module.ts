import { Module } from '@nestjs/common'
import { IncidentsModule } from '../incidents/incidents.module'
import { PlanningModule } from '../planning/planning.module'
import { DriverController } from './driver.controller'
import { DriverService } from './driver.service'

@Module({ imports: [PlanningModule, IncidentsModule], controllers: [DriverController], providers: [DriverService] })
export class DriverModule {}
