import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator'
import { ROLE_IDS, SCOPE_TYPES, type RoleId, type ScopeType } from './domain/catalog'

export class ScopeDto {
  @IsIn(SCOPE_TYPES as unknown as string[]) type: ScopeType
  @IsOptional() @IsUUID() id?: string
  @IsString() @Length(1, 120) label: string
}

export class CreateUserDto {
  @IsString() @Length(2, 120) name: string
  @IsEmail({}, { message: 'Ingrese un correo válido.' }) @MaxLength(160) email: string
  @IsArray() @ArrayMinSize(1, { message: 'Asigne al menos un rol.' }) @ArrayMaxSize(6) @IsIn(ROLE_IDS as unknown as string[], { each: true }) roles: RoleId[]
  @IsArray() @ArrayMinSize(1, { message: 'Asigne al menos un alcance.' }) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ScopeDto) scopes: ScopeDto[]
  /** PROPUESTA DE AJUSTE (DOC-E-BE §F): vincula la cuenta con un conductor (ROL-008) para su app. */
  @IsOptional() @IsUUID() driverId?: string
  /** PROPUESTA DE AJUSTE: documento del pasajero (ROL-014) que enlaza la cuenta con sus reservas (PC-A9). */
  @IsOptional() @IsString() @Length(5, 20) document?: string
}

export class UpdateUserDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsIn(ROLE_IDS as unknown as string[], { each: true }) roles?: RoleId[]
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ScopeDto) scopes?: ScopeDto[]
  @IsOptional() @IsIn(['Activo', 'Inactivo', 'Bloqueado']) status?: 'Activo' | 'Inactivo' | 'Bloqueado'
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}

export class CreateOrgUnitDto {
  @IsIn(['Organización', 'Sede', 'Base', 'Unidad', 'Flota']) type: 'Organización' | 'Sede' | 'Base' | 'Unidad' | 'Flota'
  @IsString() @Length(2, 120) name: string
  @IsOptional() @IsUUID() parentId: string | null
  @IsOptional() @IsString() @MaxLength(120) city?: string
  @IsOptional() @IsString() @MaxLength(200) address?: string
}

export class UpdateOrgUnitDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsString() @MaxLength(120) city?: string
  @IsOptional() @IsString() @MaxLength(200) address?: string
}

export class ChangePasswordDto {
  @IsString() @Length(1, 128) currentPassword: string
  @IsString() @Length(8, 128) newPassword: string
}
