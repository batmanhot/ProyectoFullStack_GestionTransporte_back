import { Module } from '@nestjs/common'
import { MastersController } from './masters.controller'
import { MastersService } from './masters.service'

@Module({ controllers: [MastersController], providers: [MastersService], exports: [MastersService] })
export class MastersModule {}
