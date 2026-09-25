import { Module } from '@nestjs/common'
import { AuditQueryService } from './audit-query.service'
import { AuditController } from './audit.controller'

@Module({ controllers: [AuditController], providers: [AuditQueryService] })
export class AuditModule {}
