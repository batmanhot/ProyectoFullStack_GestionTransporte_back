import { Module } from '@nestjs/common'
import { FleetModule } from '../fleet/fleet.module'
import { MonitoringModule } from '../monitoring/monitoring.module'
import { PassengersModule } from '../passengers/passengers.module'
import { PlanningModule } from '../planning/planning.module'
import { AnalyticsController, NotificationsController } from './analytics.controller'
import { AnalyticsService } from './analytics.service'

@Module({ imports: [FleetModule, MonitoringModule, PassengersModule, PlanningModule], controllers: [AnalyticsController, NotificationsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
