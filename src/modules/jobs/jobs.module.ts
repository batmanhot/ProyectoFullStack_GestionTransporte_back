import { Module } from '@nestjs/common'
import { MonitoringModule } from '../monitoring/monitoring.module'
import { PlatformModule } from '../platform/platform.module'
import { JobRunner } from './job-runner'
import { JobsService } from './jobs.service'

@Module({ imports: [MonitoringModule, PlatformModule], providers: [JobRunner, JobsService], exports: [JobsService] })
export class JobsModule {}
