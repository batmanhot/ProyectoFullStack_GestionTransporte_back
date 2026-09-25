import { Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator'

export class RoutePointDto {
  @IsString() @Length(1, 80) name: string
  @IsNumber() @Min(-90) @Max(90) lat: number
  @IsNumber() @Min(-180) @Max(180) lon: number
  @IsOptional() @IsIn(['Sube', 'Baja', 'Sube y baja']) stop?: 'Sube' | 'Baja' | 'Sube y baja' | null
}

export class RouteDto {
  @IsString() @Length(3, 120) name: string
  @IsString() @Length(2, 120) origin: string
  @IsString() @Length(2, 120) destination: string
  @IsInt() @Min(5) @Max(200) speedLimitKmh: number
  @IsInt() @Min(1) @Max(10_000) distanceKm: number
  @IsUUID() baseId: string
  @IsArray() @ArrayMinSize(2, { message: 'La ruta necesita al menos origen y destino.' }) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RoutePointDto) points: RoutePointDto[]
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true }) authorizedAlternatives: string[]
}

export class TripDto {
  @IsUUID() routeId: string
  @IsOptional() @IsUUID() serviceId?: string | null
  @IsISO8601() plannedDeparture: string
  @IsISO8601() plannedEta: string
  @IsOptional() @IsUUID() vehicleId: string | null
  @IsOptional() @IsUUID() driverId: string | null
  @IsIn(['Normal', 'Alta', 'Urgente']) priority: 'Normal' | 'Alta' | 'Urgente'
  @IsString() @MaxLength(1000) instructions: string
}

export class AssignTripDto {
  @IsUUID() vehicleId: string
  @IsUUID() driverId: string
  @IsInt() @Min(1) version: number
}

export class TripActionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string
  @IsOptional() @IsUUID() vehicleId?: string | null
  @IsOptional() @IsUUID() driverId?: string | null
  @IsOptional() @IsISO8601() plannedDeparture?: string
  @IsOptional() @IsISO8601() plannedEta?: string
  @IsOptional() @IsString() @MaxLength(500) sodException?: string
  @IsOptional() @IsString() @MaxLength(1000) continuityPlan?: string
  @IsOptional() @IsString() @MaxLength(1000) evidence?: string
  @IsOptional() @IsBoolean() startNow?: boolean
  /** Concurrencia optimista opcional: si se envía y no coincide ⇒ 409. */
  @IsOptional() @IsInt() @Min(1) version?: number
}

export class MessageDto {
  @IsString() @Length(1, 1000, { message: 'Escriba un mensaje (máx. 1000 caracteres).' }) text: string
}

export class ServiceDto {
  @IsString() @Length(3, 120) name: string
  @IsOptional() @IsIn(['RUC', 'DNI']) documentType?: 'RUC' | 'DNI' | null
  @IsOptional() @IsString() @MaxLength(20) document?: string | null
  @IsString() @Length(2, 160) customer: string
  @IsString() @Length(2, 80) type: string
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) routeIds: string[]
  @IsISO8601() startsAt: string
  @IsISO8601() endsAt: string
  @IsString() @MaxLength(1000) notes: string
}

export class ServiceTransitionDto {
  @IsIn(['Borrador', 'Vigente', 'Suspendido', 'Finalizado']) to: 'Borrador' | 'Vigente' | 'Suspendido' | 'Finalizado'
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
