import { Module } from '@nestjs/common'
import { PassengersModule } from '../passengers/passengers.module'
import { PublicController } from './public.controller'
import { PublicService } from './public.service'

@Module({ imports: [PassengersModule], controllers: [PublicController], providers: [PublicService] })
export class PublicModule {}
