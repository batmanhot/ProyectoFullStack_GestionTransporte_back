import { Global, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { APP_CONFIG, loadConfig } from '../config/app-config'
import { PrismaService } from '../database/prisma.service'
import { RoleMatrixService } from '../modules/access/role-matrix.service'
import { AuditService } from '../modules/audit/audit.service'
import { BcryptPasswordHasher, PasswordHasher } from '../modules/auth/password-hasher'
import { PrincipalLoader } from '../modules/auth/principal.loader'
import { TokenService } from '../modules/auth/token.service'
import { NotificationService } from '../modules/notifications/notification.service'
import { PlatformSettingsReader } from '../modules/platform/platform-settings.reader'
import { RealtimePublisher } from '../modules/realtime/realtime.publisher'
import { CountersService } from './counters.service'
import { IdempotencyService } from './idempotency/idempotency.service'
import { MetricsService } from './observability/metrics.service'

/** Capacidades transversales disponibles para todos los módulos (prompt §6). */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    AuditService,
    NotificationService,
    RealtimePublisher,
    IdempotencyService,
    RoleMatrixService,
    PlatformSettingsReader,
    TokenService,
    PrincipalLoader,
    CountersService,
    MetricsService,
    { provide: PasswordHasher, useClass: BcryptPasswordHasher },
  ],
  exports: [
    APP_CONFIG, PrismaService, AuditService, NotificationService, RealtimePublisher, IdempotencyService, RoleMatrixService,
    PlatformSettingsReader, TokenService, PrincipalLoader, CountersService, MetricsService, PasswordHasher, JwtModule,
  ],
})
export class CoreModule {}
