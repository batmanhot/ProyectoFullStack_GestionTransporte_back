import { Module } from '@nestjs/common'
import { FleetModule } from '../fleet/fleet.module'
import { PlanningModule } from '../planning/planning.module'
import { AlertEngine } from './alert.engine'
import { MonitoringController } from './monitoring.controller'
import { MonitoringService } from './monitoring.service'
import { TelemetryService } from './telemetry.service'

@Module({
  imports: [FleetModule, PlanningModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, TelemetryService, AlertEngine],
  exports: [AlertEngine, MonitoringService],
})
export class MonitoringModule {}
