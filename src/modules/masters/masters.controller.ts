import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { IsBoolean, IsIn, IsString, Length, MaxLength } from 'class-validator'
import { CurrentPrincipal, Idempotent, RequirePermission } from '../../common/decorators'
import { IdParam } from '../../common/http/params'
import type { Principal } from '../access/domain/principal'
import { MastersService } from './masters.service'

class CatalogDto {
  @IsIn(['cargoType', 'serviceType']) kind: 'cargoType' | 'serviceType'
  @IsString() @Length(2, 80) label: string
  @IsString() @MaxLength(200) hint: string
}
class CatalogUpdateDto {
  @IsString() @Length(2, 80) label: string
  @IsString() @MaxLength(200) hint: string
}
class ActiveDto {
  @IsBoolean() active: boolean
}

/** Catálogos (PC-A19) y maestro de clientes (PC-A18). */
@ApiTags('masters')
@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @Get('catalog')
  @RequirePermission('cargo.manage', 'service.manage', 'organization.configure')
  @ApiOperation({ summary: 'Ítems de un catálogo (incluye inactivos; el selector filtra por active).' })
  list(@Query('kind') kind: string) {
    return this.masters.listCatalog(kind)
  }

  @Post('catalog')
  @Idempotent()
  @RequirePermission('organization.configure')
  create(@CurrentPrincipal() p: Principal, @Body() dto: CatalogDto) {
    return this.masters.createCatalog(p, dto)
  }

  @Patch('catalog/:id')
  @RequirePermission('organization.configure')
  update(@IdParam() id: string, @Body() dto: CatalogUpdateDto) {
    return this.masters.updateCatalog(id, dto)
  }

  @Post('catalog/:id/active')
  @HttpCode(200)
  @RequirePermission('organization.configure')
  setActive(@IdParam() id: string, @Body() dto: ActiveDto) {
    return this.masters.setCatalogActive(id, dto.active)
  }

  @Get('clients/lookup')
  @RequirePermission('cargo.manage', 'service.manage')
  @ApiOperation({ summary: 'Cliente por documento (404 si es la primera vez).' })
  lookup(@Query('documentType') documentType: string, @Query('document') document: string) {
    return this.masters.lookupClient(documentType, document ?? '')
  }
}
