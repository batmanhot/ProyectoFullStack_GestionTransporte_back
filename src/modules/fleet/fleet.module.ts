import { Module } from '@nestjs/common'
import { FleetController } from './fleet.controller'
import { FleetReadModel } from './fleet.read-model'
import { FleetService } from './fleet.service'

@Module({ controllers: [FleetController], providers: [FleetService, FleetReadModel], exports: [FleetReadModel] })
export class FleetModule {}
