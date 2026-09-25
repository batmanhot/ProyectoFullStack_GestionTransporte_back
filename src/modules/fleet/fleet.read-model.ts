import { Inject, Injectable } from '@nestjs/common'
import type { ComplianceDocument, Driver, MaintenanceOrder, OrgUnit, Prisma, Vehicle } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { INSPECTION, MAINT_KIND, MAINT_STATUS, RESOURCE_TYPE } from '../../common/labels'
import { iso } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { documentPhase, driverLifecycle, evaluateDriver, evaluateVehicle, vehicleLifecycle } from './domain/eligibility'

const OPEN_TRIP = ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO'] as const

export type VehicleView = ReturnType<FleetReadModel['vehicleViewOf']>
export type DriverView = ReturnType<FleetReadModel['driverViewOf']>

interface Bundle {
  units: Map<string, OrgUnit>
  docsByResource: Map<string, ComplianceDocument[]>
  maintByVehicle: Map<string, MaintenanceOrder[]>
  incidentVehicles: Set<string>
  tripsByVehicle: Map<string, string[]>
  tripsByDriver: Map<string, string[]>
  now: number
}

const group = <T>(rows: T[], key: (t: T) => string | null) => {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    if (k) m.set(k, [...(m.get(k) ?? []), r])
  }
  return m
}

/**
 * Modelo de lectura de recursos: calcula en el SERVIDOR elegibilidad, condiciones y lifecycle derivado (el FE no los calcula).
 * Carga en bloque lo necesario (documentos, mantenimiento, incidencias y viajes abiertos) para evitar consultas N+1.
 */
@Injectable()
export class FleetReadModel {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get expiringDays(): number {
    return this.config.ops.docExpiringDays
  }

  async bundle(client: Tx = this.prisma.db, resourceIds?: string[]): Promise<Bundle> {
    const idFilter = resourceIds ? { in: resourceIds } : undefined
    const [units, docs, maint, incidents, trips] = await Promise.all([
      client.orgUnit.findMany(),
      client.complianceDocument.findMany({ where: { replaced: false, ...(idFilter ? { resourceId: idFilter } : {}) } }),
      client.maintenanceOrder.findMany({ where: idFilter ? { vehicleId: idFilter } : {} }),
      client.incident.findMany({ where: { status: { notIn: ['RESUELTA', 'CERRADA'] }, vehicleId: idFilter ?? { not: null } }, select: { vehicleId: true } }),
      client.trip.findMany({
        where: { lifecycle: { in: [...OPEN_TRIP] }, ...(idFilter ? { OR: [{ vehicleId: idFilter }, { driverId: idFilter }] } : {}) },
        select: { vehicleId: true, driverId: true, lifecycle: true },
      }),
    ])
    const tripsByVehicle = new Map<string, string[]>()
    const tripsByDriver = new Map<string, string[]>()
    for (const t of trips) {
      if (t.vehicleId) tripsByVehicle.set(t.vehicleId, [...(tripsByVehicle.get(t.vehicleId) ?? []), t.lifecycle])
      if (t.driverId) tripsByDriver.set(t.driverId, [...(tripsByDriver.get(t.driverId) ?? []), t.lifecycle])
    }
    return {
      units: new Map(units.map((u) => [u.id, u])),
      docsByResource: group(docs, (d) => d.resourceId),
      maintByVehicle: group(maint, (m) => m.vehicleId),
      incidentVehicles: new Set(incidents.map((i) => i.vehicleId).filter((x): x is string => !!x)),
      tripsByVehicle,
      tripsByDriver,
      now: Date.now(),
    }
  }

  vehicleViewOf(v: Vehicle, b: Bundle) {
    const r = evaluateVehicle(
      {
        blocked: v.blocked,
        blockReason: v.blockReason,
        outOfService: v.outOfService,
        docs: b.docsByResource.get(v.id) ?? [],
        maintenance: b.maintByVehicle.get(v.id) ?? [],
        hasOpenIncident: b.incidentVehicles.has(v.id),
      },
      b.now,
      this.expiringDays,
    )
    const base = b.units.get(v.baseId)
    return {
      id: v.id,
      plate: v.plate,
      vehicleClass: v.vehicleClass,
      fleetId: v.fleetId,
      fleetName: b.units.get(v.fleetId)?.name ?? '—',
      baseId: v.baseId,
      baseName: base?.name ?? '—',
      baseCity: base?.city ?? null,
      capacityPassengers: v.capacityPassengers,
      capacityKg: v.capacityKg,
      fuel: v.fuel,
      odometerKm: v.odometerKm,
      gpsDeviceId: v.gpsDeviceId,
      lifecycle: vehicleLifecycle(v.lifecycle, b.tripsByVehicle.get(v.id) ?? []),
      conditions: r.conditions,
      eligibility: r.eligibility,
      eligibilityReasons: r.reasons,
      ...(v.blockReason ? { blockReason: v.blockReason } : {}),
      version: v.version,
    }
  }

  driverViewOf(d: Driver, b: Bundle) {
    const r = evaluateDriver(d, b.now, this.expiringDays)
    const base = b.units.get(d.baseId)
    return {
      id: d.id,
      name: d.name,
      licenseNo: d.licenseNo,
      licenseCategory: d.licenseCategory,
      licenseExpiry: d.licenseExpiry.toISOString(),
      baseId: d.baseId,
      baseName: base?.name ?? '—',
      baseCity: base?.city ?? null,
      lifecycle: driverLifecycle(d, b.now, b.tripsByDriver.get(d.id) ?? []),
      conditions: r.conditions,
      eligibility: r.eligibility,
      eligibilityReasons: r.reasons,
      restrictions: d.restrictions,
      trainingPending: d.trainingPending,
      aptitudePending: d.aptitudePending,
      userId: d.userId,
      version: d.version,
    }
  }

  documentView(d: ComplianceDocument, now = Date.now()) {
    return {
      id: d.id,
      resourceType: RESOURCE_TYPE.label(d.resourceType),
      resourceId: d.resourceId,
      resourceLabel: d.resourceLabel,
      docType: d.docType,
      number: d.number,
      issuedAt: d.issuedAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      lifecycle: documentPhase(d, now, this.expiringDays),
      critical: d.critical,
      fileName: d.fileName,
      fileId: d.fileId,
      fileSize: d.fileSize,
      fileType: d.fileType,
    }
  }

  maintenanceView(m: MaintenanceOrder) {
    return {
      id: m.id,
      code: m.code,
      vehicleId: m.vehicleId,
      vehiclePlate: m.vehiclePlate,
      kind: MAINT_KIND.label(m.kind),
      status: MAINT_STATUS.label(m.status),
      scheduledAt: m.scheduledAt.toISOString(),
      description: m.description,
      critical: m.critical,
      inspectionResult: m.inspectionResult ? INSPECTION.label(m.inspectionResult) : null,
      createdBy: m.createdBy,
      odometerKm: m.odometerKm,
      cancelReason: m.cancelReason,
      createdAt: iso(m.createdAt),
    }
  }

  async vehicleViews(where: Prisma.VehicleWhereInput = {}, client: Tx = this.prisma.db) {
    const [rows, b] = await Promise.all([client.vehicle.findMany({ where, orderBy: { plate: 'asc' } }), this.bundle(client)])
    return rows.map((v) => this.vehicleViewOf(v, b))
  }

  async driverViews(where: Prisma.DriverWhereInput = {}, client: Tx = this.prisma.db) {
    const [rows, b] = await Promise.all([client.driver.findMany({ where, orderBy: { name: 'asc' } }), this.bundle(client)])
    return rows.map((d) => this.driverViewOf(d, b))
  }

  async vehicleView(id: string, client: Tx = this.prisma.db) {
    const [v, b] = await Promise.all([client.vehicle.findFirst({ where: { id } }), this.bundle(client, [id])])
    return v ? this.vehicleViewOf(v, b) : null
  }

  async driverView(id: string, client: Tx = this.prisma.db) {
    const [d, b] = await Promise.all([client.driver.findFirst({ where: { id } }), this.bundle(client, [id])])
    return d ? this.driverViewOf(d, b) : null
  }
}
