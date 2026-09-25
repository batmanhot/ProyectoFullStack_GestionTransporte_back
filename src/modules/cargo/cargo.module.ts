import { Module } from '@nestjs/common'
import { MastersModule } from '../masters/masters.module'
import { CargoController } from './cargo.controller'
import { CargoService } from './cargo.service'

@Module({ imports: [MastersModule], controllers: [CargoController], providers: [CargoService] })
export class CargoModule {}
