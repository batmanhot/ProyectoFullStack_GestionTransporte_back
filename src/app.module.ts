import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerModule } from '@nestjs/throttler'
import { CoreModule } from './common/core.module'
import { ProblemFilter } from './common/filters/problem.filter'
import { AuthGuard } from './common/guards/auth.guard'
import { PermissionGuard } from './common/guards/permission.guard'
import { UserThrottlerGuard } from './common/guards/user-throttler.guard'
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor'
import { structuralValidationPipe } from './common/pipes/validation.pipe'
import { AccessModule } from './modules/access/access.module'
import { AnalyticsModule } from './modules/analytics/analytics.module'
import { AuditModule } from './modules/audit/audit.module'
import { AuthController } from './modules/auth/auth.controller'
import { CargoModule } from './modules/cargo/cargo.module'
import { DriverModule } from './modules/driver/driver.module'
import { AuthService } from './modules/auth/auth.service'
import { FleetModule } from './modules/fleet/fleet.module'
import { FilesModule } from './modules/files/files.module'
import { HealthController } from './modules/health/health.controller'
import { JobsModule } from './modules/jobs/jobs.module'
import { IncidentsModule } from './modules/incidents/incidents.module'
import { MastersModule } from './modules/masters/masters.module'
import { MonitoringModule } from './modules/monitoring/monitoring.module'
import { PassengersModule } from './modules/passengers/passengers.module'
import { PlanningModule } from './modules/planning/planning.module'
import { PlatformModule } from './modules/platform/platform.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { PublicModule } from './modules/public/public.module'

/**
 * Monolito modular (ADR-001). Orden de guards: autenticación → rate limit → permiso.
 * El alcance y las políticas (SoD, gate, estado) se evalúan en cada servicio de dominio.
 */
@Module({
  imports: [
    CoreModule,
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),
    ScheduleModule.forRoot(),
    // SUPUESTO TÉCNICO (prompt §31): 600 req/min por usuario autenticado o IP; políticas más estrictas por endpoint.
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }] }),
    AccessModule,
    FleetModule,
    MastersModule,
    PlanningModule,
    MonitoringModule,
    IncidentsModule,
    DriverModule,
    CargoModule,
    PassengersModule,
    PublicModule,
    FilesModule,
    AuditModule,
    AnalyticsModule,
    RealtimeModule,
    PlatformModule,
    JobsModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_PIPE, useFactory: structuralValidationPipe },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
