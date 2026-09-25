import { Module } from '@nestjs/common'
import { RealtimeModule } from '../realtime/realtime.module'
import { PlatformController } from './platform.controller'
import { PlatformGovernanceService } from './platform-governance.service'
import { PlatformTenantsService } from './platform-tenants.service'

@Module({
  imports: [RealtimeModule],
  controllers: [PlatformController],
  providers: [PlatformTenantsService, PlatformGovernanceService],
  exports: [PlatformGovernanceService],
})
export class PlatformModule {}
