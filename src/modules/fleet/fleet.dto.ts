import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength } from 'class-validator'

const PLATE = /^[A-Z0-9-]{3,12}$/i

export class VehicleDto {
  @IsString() @Matches(PLATE, { message: 'La placa debe tener entre 3 y 12 caracteres (letras, números y guion).' }) plate: string
  @IsString() @Length(2, 60) vehicleClass: string
  @IsUUID() fleetId: string
  @IsUUID() baseId: string
  @IsInt() @Min(0) @Max(120) capacityPassengers: number
  @IsInt() @Min(0) @Max(80_000) capacityKg: number
  @IsString() @Length(2, 40) fuel: string
  @IsInt() @Min(0) @Max(5_000_000) odometerKm: number
  @IsOptional() @IsString() @MaxLength(60) gpsDeviceId: string | null
}

export class UpdateVehicleDto {
  @IsOptional() @IsString() @Matches(PLATE) plate?: string
  @IsOptional() @IsString() @Length(2, 60) vehicleClass?: string
  @IsOptional() @IsUUID() fleetId?: string
  @IsOptional() @IsUUID() baseId?: string
  @IsOptional() @IsInt() @Min(0) @Max(120) capacityPassengers?: number
  @IsOptional() @IsInt() @Min(0) @Max(80_000) capacityKg?: number
  @IsOptional() @IsString() @Length(2, 40) fuel?: string
  @IsOptional() @IsInt() @Min(0) @Max(5_000_000) odometerKm?: number
  @IsOptional() @IsString() @MaxLength(60) gpsDeviceId?: string | null
  @IsInt() @Min(1) version: number
}

export class ReasonDto {
  @IsString() @MinLength(5, { message: 'Indique el motivo (mín. 5 caracteres).' }) @MaxLength(500) reason: string
}

export class VehicleServiceDto extends ReasonDto {
  @IsBoolean() inService: boolean
}

export class DriverActiveDto extends ReasonDto {
  @IsBoolean() active: boolean
}

export class DriverDto {
  @IsString() @Length(3, 120) name: string
  @IsString() @Length(3, 30) licenseNo: string
  @IsString() @Length(1, 10) licenseCategory: string
  @IsISO8601() licenseExpiry: string
  @IsUUID() baseId: string
  @IsString() @MaxLength(300) restrictions: string
  @IsBoolean() trainingPending: boolean
  @IsBoolean() aptitudePending: boolean
}

export class UpdateDriverDto {
  @IsOptional() @IsString() @Length(3, 120) name?: string
  @IsOptional() @IsString() @Length(3, 30) licenseNo?: string
  @IsOptional() @IsString() @Length(1, 10) licenseCategory?: string
  @IsOptional() @IsISO8601() licenseExpiry?: string
  @IsOptional() @IsUUID() baseId?: string
  @IsOptional() @IsString() @MaxLength(300) restrictions?: string
  @IsOptional() @IsBoolean() trainingPending?: boolean
  @IsOptional() @IsBoolean() aptitudePending?: boolean
  @IsInt() @Min(1) version: number
}

export class DocumentDto {
  @IsIn(['Vehículo', 'Conductor']) resourceType: 'Vehículo' | 'Conductor'
  @IsUUID() resourceId: string
  @IsString() @Length(2, 80) docType: string
  @IsString() @Length(1, 60) number: string
  @IsISO8601() issuedAt: string
  @IsISO8601() expiresAt: string
  @IsBoolean() critical: boolean
  @IsOptional() @IsString() @MaxLength(120) fileName: string | null
  @IsOptional() @IsUUID() fileId?: string | null
}

export class MaintenanceDto {
  @IsUUID() vehicleId: string
  @IsIn(['Preventivo', 'Correctivo', 'Inspección']) kind: 'Preventivo' | 'Correctivo' | 'Inspección'
  @IsISO8601() scheduledAt: string
  @IsString() @MinLength(5, { message: 'Describa el trabajo (mín. 5 caracteres).' }) @MaxLength(500) description: string
  @IsBoolean() critical: boolean
}

export class UpdateMaintenanceDto {
  @IsISO8601() scheduledAt: string
  @IsString() @MinLength(5, { message: 'Describa el trabajo (mín. 5 caracteres).' }) @MaxLength(500) description: string
  @IsBoolean() critical: boolean
}

export class AdvanceMaintenanceDto {
  @IsIn(['Pendiente', 'Programada', 'En ejecución', 'Completada', 'Cerrada', 'Cancelada']) to: string
  @IsOptional() @IsIn(['Aprobada', 'Rechazada']) inspectionResult?: 'Aprobada' | 'Rechazada'
  @IsOptional() @IsInt() @Min(0) @Max(5_000_000) odometerKm?: number
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
