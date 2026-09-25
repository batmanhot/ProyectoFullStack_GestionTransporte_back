import { Injectable } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { MAINT_KIND, MAINT_STATUS, RESOURCE_TYPE } from '../../common/labels'
import { pageInMemory, parseListQuery, type RawQuery } from '../../common/http/list-query'
import { clean, parseDate } from '../../common/http/params'
import { CountersService } from '../../common/counters.service'
import { PrismaService, type Tx } from '../../database/prisma.service'
import { hasRole, type Principal } from '../access/domain/principal'
import { NATIVE_APPROVERS } from '../access/domain/catalog'
import { DataScope } from '../access/domain/scope'
import { AuditService } from '../audit/audit.service'
import { documentPhase, evaluateVehicle } from './domain/eligibility'
import type { AdvanceMaintenanceDto, DocumentDto, DriverDto, MaintenanceDto, UpdateDriverDto, UpdateMaintenanceDto, UpdateVehicleDto, VehicleDto } from './fleet.dto'
import { FleetReadModel } from './fleet.read-model'

const OPEN_ASSIGNED = ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO'] as const
const MAINT_FLOW: Record<string, string[]> = {
  PENDIENTE: ['PROGRAMADA', 'CANCELADA'],
  PROGRAMADA: ['EN_EJECUCION', 'CANCELADA'],
  EN_EJECUCION: ['COMPLETADA'],
  COMPLETADA: ['CERRADA'],
  CERRADA: [],
  CANCELADA: [],
}
const km = (n: number) => `${new Intl.NumberFormat('es').format(n)} km`

/**
 * Recursos y cumplimiento (PROC-002/008 · RF-003–007 · FE-010–013).
 * Autorización = permiso (guard) + ALCANCE (base/flota del usuario, aquí) + política (SoD-002, estados).
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly read: FleetReadModel,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
  ) {}

  private vehicleScope(p: Principal): Prisma.VehicleWhereInput {
    return new DataScope(p).baseWhere(true) ?? {}
  }

  private async findVehicle(tx: Tx, p: Principal, id: string) {
    const v = await tx.vehicle.findFirst({ where: { id, ...this.vehicleScope(p) } })
    if (!v) throw Errors.unavailable()
    return v
  }

  private async assertUnits(tx: Tx, p: Principal, baseId: string, fleetId?: string) {
    const [base, fleet] = await Promise.all([
      tx.orgUnit.findFirst({ where: { id: baseId, type: 'BASE', active: true } }),
      fleetId ? tx.orgUnit.findFirst({ where: { id: fleetId, type: 'FLOTA', active: true } }) : Promise.resolve(null),
    ])
    const errs = new FieldErrors()
    errs.when(!base, 'baseId', 'La terminal no existe o está inactiva.')
    errs.when(!!fleetId && !fleet, 'fleetId', 'La flota no existe o está inactiva.')
    errs.throwIfAny()
    if (!new DataScope(p).covers(baseId, fleetId)) throw Errors.forbidden('No puede registrar recursos en una terminal o flota fuera de su alcance.')
  }

  /**
   * Registrado → Disponible (DOC-A PROC-002) cuando el vehículo tiene requisitos registrados: al menos un documento crítico
   * vigente y ninguna causa de «No habilitado». SUPUESTO: el catálogo de documentos obligatorios por tipo es GAP-010.
   */
  private async promoteIfReady(tx: Tx, vehicleId: string) {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId } })
    if (!v || v.lifecycle !== 'REGISTRADO') return
    const [docs, maint, inc] = await Promise.all([
      tx.complianceDocument.findMany({ where: { resourceId: v.id, replaced: false } }),
      tx.maintenanceOrder.findMany({ where: { vehicleId: v.id } }),
      tx.incident.count({ where: { vehicleId: v.id, status: { notIn: ['RESUELTA', 'CERRADA'] } } }),
    ])
    const now = Date.now()
    const hasCriticalValid = docs.some((d) => d.critical && documentPhase(d, now, this.read.expiringDays) !== 'Vencido')
    const r = evaluateVehicle({ blocked: v.blocked, blockReason: v.blockReason, outOfService: v.outOfService, docs, maintenance: maint, hasOpenIncident: inc > 0 }, now, this.read.expiringDays)
    if (hasCriticalValid && r.eligibility !== 'No habilitado') await tx.vehicle.update({ where: { id: v.id }, data: { lifecycle: 'DISPONIBLE' } })
  }

  /* ─────────── vehículos ─────────── */

  async listVehicles(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['plate', 'vehicleClass', 'fleetName', 'baseName', 'odometerKm', 'lifecycle', 'eligibility'], filters: ['lifecycle', 'eligibility', 'fleetId', 'baseId', 'condition'], defaultSort: { field: 'plate', dir: 'asc' } })
    const items = await this.read.vehicleViews(this.vehicleScope(p))
    return pageInMemory(items, q, {
      search: (v) => `${v.plate} ${v.vehicleClass} ${v.fleetName} ${v.baseName}`,
      filters: {
        lifecycle: (v, x) => v.lifecycle === x,
        eligibility: (v, x) => v.eligibility === x,
        fleetId: (v, x) => v.fleetId === x,
        baseId: (v, x) => v.baseId === x,
        condition: (v, x) => (v.conditions as string[]).includes(x),
      },
      facets: { lifecycle: (v) => v.lifecycle, eligibility: (v) => v.eligibility, condition: (v) => v.conditions },
      sort: { plate: (v) => v.plate, vehicleClass: (v) => v.vehicleClass, fleetName: (v) => v.fleetName, baseName: (v) => v.baseName, odometerKm: (v) => v.odometerKm, lifecycle: (v) => v.lifecycle, eligibility: (v) => v.eligibility },
    })
  }

  async createVehicle(p: Principal, dto: VehicleDto) {
    return this.prisma.tx(async (tx) => {
      await this.assertUnits(tx, p, dto.baseId, dto.fleetId)
      const plate = dto.plate.trim().toUpperCase()
      const errs = new FieldErrors()
      if (await tx.vehicle.findFirst({ where: { plate }, select: { id: true } })) errs.add('plate', 'La placa ya está registrada en su organización.')
      const gps = clean(dto.gpsDeviceId) || null
      if (gps && (await tx.vehicle.findFirst({ where: { gpsDeviceId: gps }, select: { id: true } }))) errs.add('gpsDeviceId', 'Ese dispositivo GPS ya está asociado a otro vehículo.')
      errs.throwIfAny()
      const v = await tx.vehicle.create({
        data: { tenantId: p.tenantId as string, plate, vehicleClass: clean(dto.vehicleClass), fleetId: dto.fleetId, baseId: dto.baseId, capacityPassengers: dto.capacityPassengers, capacityKg: dto.capacityKg, fuel: clean(dto.fuel), odometerKm: dto.odometerKm, gpsDeviceId: gps },
      })
      await this.audit.record({ resourceType: 'Vehículo', resourceId: v.plate, action: 'vehicle.create', after: `${v.vehicleClass} · ${v.capacityPassengers} pax · ${v.capacityKg} kg` }, tx)
      return this.read.vehicleView(v.id, tx)
    })
  }

  async updateVehicle(p: Principal, id: string, dto: UpdateVehicleDto) {
    return this.prisma.tx(async (tx) => {
      const v = await this.findVehicle(tx, p, id)
      if (v.version !== dto.version) throw Errors.staleVersion('Otro usuario modificó este vehículo. Recargue para ver la versión actual.')
      const errs = new FieldErrors()
      if (dto.odometerKm !== undefined && dto.odometerKm < v.odometerKm) errs.add('odometerKm', `El odómetro no puede ser menor al último valor aceptado (${km(v.odometerKm)}) — EXC-003.`)
      const plate = dto.plate?.trim().toUpperCase()
      if (plate && plate !== v.plate && (await tx.vehicle.findFirst({ where: { plate }, select: { id: true } }))) errs.add('plate', 'La placa ya está registrada en su organización.')
      const gps = dto.gpsDeviceId === undefined ? undefined : clean(dto.gpsDeviceId) || null
      if (gps && gps !== v.gpsDeviceId && (await tx.vehicle.findFirst({ where: { gpsDeviceId: gps }, select: { id: true } }))) errs.add('gpsDeviceId', 'Ese dispositivo GPS ya está asociado a otro vehículo.')
      errs.throwIfAny()
      if (dto.baseId || dto.fleetId) await this.assertUnits(tx, p, dto.baseId ?? v.baseId, dto.fleetId ?? v.fleetId)
      const updated = await tx.vehicle.updateMany({
        where: { id, version: dto.version },
        data: {
          ...(plate ? { plate } : {}),
          ...(dto.vehicleClass ? { vehicleClass: clean(dto.vehicleClass) } : {}),
          ...(dto.fleetId ? { fleetId: dto.fleetId } : {}),
          ...(dto.baseId ? { baseId: dto.baseId } : {}),
          ...(dto.capacityPassengers !== undefined ? { capacityPassengers: dto.capacityPassengers } : {}),
          ...(dto.capacityKg !== undefined ? { capacityKg: dto.capacityKg } : {}),
          ...(dto.fuel ? { fuel: clean(dto.fuel) } : {}),
          ...(dto.odometerKm !== undefined ? { odometerKm: dto.odometerKm } : {}),
          ...(gps !== undefined ? { gpsDeviceId: gps } : {}),
          version: { increment: 1 },
        },
      })
      if (updated.count !== 1) throw Errors.staleVersion()
      await this.audit.record({ resourceType: 'Vehículo', resourceId: plate ?? v.plate, action: 'vehicle.update', before: `v${v.version} · ${km(v.odometerKm)}`, after: `v${v.version + 1}${dto.odometerKm !== undefined ? ` · ${km(dto.odometerKm)}` : ''}` }, tx)
      await this.promoteIfReady(tx, id)
      return this.read.vehicleView(id, tx)
    })
  }

  async blockVehicle(p: Principal, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const v = await this.findVehicle(tx, p, id)
      if (v.blocked) throw Errors.conflict('Vehículo ya bloqueado', `El vehículo está bloqueado: ${v.blockReason ?? 'sin motivo'}.`)
      await tx.vehicle.update({ where: { id }, data: { blocked: true, blockReason: clean(reason), blockedById: p.userId, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Vehículo', resourceId: v.plate, action: 'vehicle.block', reason: clean(reason), after: 'Bloqueado' }, tx)
      return this.read.vehicleView(id, tx)
    })
  }

  /** CTRL-024 + SOD-002: quien registró el bloqueo no lo libera sin revisión de otro rol autorizado. */
  async unblockVehicle(p: Principal, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const v = await this.findVehicle(tx, p, id)
      if (!v.blocked) throw Errors.conflict('Vehículo no bloqueado', 'El vehículo no tiene un bloqueo vigente.')
      // PC-A1: el Jefe de transporte y los Administradores del negocio (aprobadores nativos) pueden liberar su propio bloqueo.
      const reviewer = hasRole(p, 'ROL-003', ...NATIVE_APPROVERS)
      if (v.blockedById === p.userId && !reviewer) {
        await this.audit.recordSafe({ kind: 'Seguridad', resourceType: 'Vehículo', resourceId: v.plate, action: 'sod.violation', result: 'DENEGADO', after: 'SOD-002' })
        throw Errors.forbidden('Usted registró este bloqueo: no puede liberarlo sin revisión de otro rol autorizado (SOD-002).', { rule: 'SOD-002' })
      }
      await tx.vehicle.update({ where: { id }, data: { blocked: false, blockReason: null, blockedById: null, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Vehículo', resourceId: v.plate, action: 'vehicle.unblock', reason: clean(reason), before: `Bloqueado: ${v.blockReason ?? ''}`, after: 'Liberado' }, tx)
      await this.promoteIfReady(tx, id)
      return this.read.vehicleView(id, tx)
    })
  }

  /** «Eliminar» = baja de servicio (nunca borrado físico). No se da de baja un vehículo con viaje activo. */
  async setVehicleService(p: Principal, id: string, inService: boolean, reason: string) {
    return this.prisma.tx(async (tx) => {
      const v = await this.findVehicle(tx, p, id)
      if (!inService) {
        const open = await tx.trip.findFirst({ where: { vehicleId: id, lifecycle: { in: [...OPEN_ASSIGNED] } }, select: { code: true } })
        if (open) throw Errors.conflict('Vehículo en uso', `Está asignado al viaje ${open.code}. Reasigne o cancele el viaje antes de darlo de baja.`)
      }
      await tx.vehicle.update({ where: { id }, data: { outOfService: !inService, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Vehículo', resourceId: v.plate, action: inService ? 'vehicle.reinstate' : 'vehicle.retire', reason: clean(reason), after: inService ? 'En servicio' : 'Fuera de servicio' }, tx)
      return this.read.vehicleView(id, tx)
    })
  }

  /* ─────────── conductores ─────────── */

  async listDrivers(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['name', 'licenseNo', 'licenseExpiry', 'baseName', 'lifecycle', 'eligibility'], filters: ['eligibility', 'lifecycle', 'condition', 'baseId'], defaultSort: { field: 'name', dir: 'asc' } })
    const items = await this.read.driverViews(new DataScope(p).baseWhere() ?? {})
    return pageInMemory(items, q, {
      search: (d) => `${d.name} ${d.licenseNo}`,
      filters: { eligibility: (d, v) => d.eligibility === v, lifecycle: (d, v) => d.lifecycle === v, condition: (d, v) => (d.conditions as string[]).includes(v), baseId: (d, v) => d.baseId === v },
      facets: { eligibility: (d) => d.eligibility, lifecycle: (d) => d.lifecycle, condition: (d) => d.conditions },
      sort: { name: (d) => d.name, licenseNo: (d) => d.licenseNo, licenseExpiry: (d) => d.licenseExpiry, baseName: (d) => d.baseName, lifecycle: (d) => d.lifecycle, eligibility: (d) => d.eligibility },
    })
  }

  async createDriver(p: Principal, dto: DriverDto) {
    const expiry = parseDate(dto.licenseExpiry)
    if (!expiry) throw Errors.field('licenseExpiry', 'Fecha inválida.')
    return this.prisma.tx(async (tx) => {
      await this.assertUnits(tx, p, dto.baseId)
      const licenseNo = clean(dto.licenseNo).toUpperCase()
      if (await tx.driver.findFirst({ where: { licenseNo }, select: { id: true } })) throw Errors.field('licenseNo', 'Ya existe un conductor con esa licencia.')
      const d = await tx.driver.create({
        data: { tenantId: p.tenantId as string, name: clean(dto.name), licenseNo, licenseCategory: clean(dto.licenseCategory), licenseExpiry: expiry, baseId: dto.baseId, restrictions: clean(dto.restrictions), trainingPending: dto.trainingPending, aptitudePending: dto.aptitudePending },
      })
      await this.audit.record({ resourceType: 'Conductor', resourceId: d.name, action: 'driver.create', after: `Licencia ${d.licenseCategory} hasta ${dto.licenseExpiry.slice(0, 10)}` }, tx)
      return this.read.driverView(d.id, tx)
    })
  }

  async updateDriver(p: Principal, id: string, dto: UpdateDriverDto) {
    return this.prisma.tx(async (tx) => {
      const d = await tx.driver.findFirst({ where: { id, ...(new DataScope(p).baseWhere() ?? {}) } })
      if (!d) throw Errors.unavailable()
      if (d.version !== dto.version) throw Errors.staleVersion('Otro usuario modificó este conductor. Recargue para ver la versión actual.')
      const expiry = dto.licenseExpiry ? parseDate(dto.licenseExpiry) : undefined
      if (expiry === null) throw Errors.field('licenseExpiry', 'Fecha inválida.')
      const licenseNo = dto.licenseNo ? clean(dto.licenseNo).toUpperCase() : undefined
      if (licenseNo && licenseNo !== d.licenseNo && (await tx.driver.findFirst({ where: { licenseNo }, select: { id: true } }))) throw Errors.field('licenseNo', 'Ya existe un conductor con esa licencia.')
      if (dto.baseId) await this.assertUnits(tx, p, dto.baseId)
      const r = await tx.driver.updateMany({
        where: { id, version: dto.version },
        data: {
          ...(dto.name ? { name: clean(dto.name) } : {}),
          ...(licenseNo ? { licenseNo } : {}),
          ...(dto.licenseCategory ? { licenseCategory: clean(dto.licenseCategory) } : {}),
          ...(expiry ? { licenseExpiry: expiry } : {}),
          ...(dto.baseId ? { baseId: dto.baseId } : {}),
          ...(dto.restrictions !== undefined ? { restrictions: clean(dto.restrictions) } : {}),
          ...(dto.trainingPending !== undefined ? { trainingPending: dto.trainingPending } : {}),
          ...(dto.aptitudePending !== undefined ? { aptitudePending: dto.aptitudePending } : {}),
          version: { increment: 1 },
        },
      })
      if (r.count !== 1) throw Errors.staleVersion()
      await this.audit.record({ resourceType: 'Conductor', resourceId: d.name, action: 'driver.update', before: `v${d.version}`, after: `v${d.version + 1}` }, tx)
      return this.read.driverView(id, tx)
    })
  }

  async setDriverActive(p: Principal, id: string, active: boolean, reason: string) {
    return this.prisma.tx(async (tx) => {
      const d = await tx.driver.findFirst({ where: { id, ...(new DataScope(p).baseWhere() ?? {}) } })
      if (!d) throw Errors.unavailable()
      if (!active) {
        const open = await tx.trip.findFirst({ where: { driverId: id, lifecycle: { in: [...OPEN_ASSIGNED] } }, select: { code: true } })
        if (open) throw Errors.conflict('Conductor en uso', `Está asignado al viaje ${open.code}. Reasigne o cancele el viaje antes de inactivarlo.`)
      }
      await tx.driver.update({ where: { id }, data: { inactive: !active, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Conductor', resourceId: d.name, action: active ? 'driver.reactivate' : 'driver.deactivate', reason: clean(reason) }, tx)
      return this.read.driverView(id, tx)
    })
  }

  /* ─────────── documentos ─────────── */

  async listDocuments(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['resourceLabel', 'docType', 'expiresAt', 'lifecycle'], filters: ['lifecycle', 'resourceType', 'resourceId', 'critical'], defaultSort: { field: 'expiresAt', dir: 'asc' } })
    const scope = new DataScope(p)
    const db = this.prisma.db
    const [docs, vehicles, drivers] = await Promise.all([
      db.complianceDocument.findMany({ orderBy: { expiresAt: 'asc' } }),
      db.vehicle.findMany({ select: { id: true, baseId: true, fleetId: true } }),
      db.driver.findMany({ select: { id: true, baseId: true } }),
    ])
    const visible = new Set([...vehicles.filter((v) => scope.covers(v.baseId, v.fleetId)).map((v) => v.id), ...drivers.filter((d) => scope.covers(d.baseId)).map((d) => d.id)])
    const now = Date.now()
    const items = docs.filter((d) => visible.has(d.resourceId)).map((d) => this.read.documentView(d, now))
    return pageInMemory(items, q, {
      search: (d) => `${d.resourceLabel} ${d.docType} ${d.number}`,
      filters: { lifecycle: (d, v) => d.lifecycle === v, resourceType: (d, v) => d.resourceType === v, resourceId: (d, v) => d.resourceId === v, critical: (d, v) => String(d.critical) === v },
      facets: { lifecycle: (d) => d.lifecycle, resourceType: (d) => d.resourceType },
      sort: { resourceLabel: (d) => d.resourceLabel, docType: (d) => d.docType, expiresAt: (d) => d.expiresAt, lifecycle: (d) => d.lifecycle },
    })
  }

  /** RN-009: registrar un documento del mismo tipo REEMPLAZA al anterior (queda «Reemplazado»), y resuelve su alerta de vencimiento. */
  async createDocument(p: Principal, dto: DocumentDto) {
    const issued = parseDate(dto.issuedAt)
    const expires = parseDate(dto.expiresAt)
    const errs = new FieldErrors()
    errs.when(!issued, 'issuedAt', 'Fecha de emisión inválida.')
    errs.when(!expires, 'expiresAt', 'Fecha de vencimiento inválida.')
    errs.when(!!issued && !!expires && expires <= issued, 'expiresAt', 'La vigencia debe ser posterior a la emisión.')
    errs.throwIfAny()
    const resourceType = RESOURCE_TYPE.parse(dto.resourceType)!
    const scope = new DataScope(p)
    return this.prisma.tx(async (tx) => {
      let label: string | undefined
      if (resourceType === 'VEHICULO') {
        const v = await tx.vehicle.findFirst({ where: { id: dto.resourceId } })
        if (v && scope.covers(v.baseId, v.fleetId)) label = v.plate
      } else {
        const d = await tx.driver.findFirst({ where: { id: dto.resourceId } })
        if (d && scope.covers(d.baseId)) label = d.name
      }
      if (!label) throw Errors.field('resourceId', 'El recurso no existe o está fuera de su alcance.')
      const file = dto.fileId ? await tx.storedFile.findFirst({ where: { id: dto.fileId, status: 'DISPONIBLE' } }) : null
      if (dto.fileId && !file) throw Errors.field('fileId', 'El archivo no existe o expiró: vuelva a subirlo.')
      const replaced = await tx.complianceDocument.findMany({ where: { resourceId: dto.resourceId, docType: clean(dto.docType), replaced: false }, select: { id: true } })
      if (replaced.length) await tx.complianceDocument.updateMany({ where: { id: { in: replaced.map((r) => r.id) } }, data: { replaced: true, replacedAt: new Date() } })
      const doc = await tx.complianceDocument.create({
        data: {
          tenantId: p.tenantId as string, resourceType, resourceId: dto.resourceId, resourceLabel: label, docType: clean(dto.docType), number: clean(dto.number),
          issuedAt: issued!, expiresAt: expires!, critical: dto.critical, createdBy: p.name,
          fileId: file?.id ?? null, fileName: file?.name ?? (clean(dto.fileName) || null), fileSize: file?.size ?? null, fileType: file?.type ?? null,
        },
      })
      await this.audit.record({ resourceType: 'Documento', resourceId: `${label} · ${doc.docType}`, action: 'document.create', after: `N° ${doc.number} hasta ${dto.expiresAt.slice(0, 10)}${replaced.length ? ' (reemplaza al anterior)' : ''}` }, tx)
      // PC-A7: el seguimiento se cierra solo — la alerta del documento reemplazado queda resuelta con su evidencia.
      if (replaced.length) {
        const alerts = await tx.alert.findMany({ where: { documentId: { in: replaced.map((r) => r.id) }, status: { notIn: ['RESUELTA', 'CERRADA'] } } })
        for (const a of alerts) {
          await tx.alert.update({
            where: { id: a.id },
            data: { status: 'RESUELTA', resolvedAt: new Date(), evidence: `Documento renovado: N° ${doc.number}, vigente hasta ${dto.expiresAt.slice(0, 10)} (${p.name}).`, version: { increment: 1 } },
          })
          await this.audit.record({ resourceType: 'Alerta', resourceId: a.id, action: 'alert.resolve', before: a.status, after: 'Resuelta', reason: 'Documento renovado' }, tx)
        }
      }
      if (resourceType === 'VEHICULO') await this.promoteIfReady(tx, dto.resourceId)
      return this.read.documentView(doc)
    })
  }

  /* ─────────── mantenimiento ─────────── */

  async listMaintenance(p: Principal, raw: RawQuery) {
    const q = parseListQuery(raw, { sortable: ['code', 'vehiclePlate', 'scheduledAt', 'status', 'kind'], filters: ['status', 'kind', 'critical', 'openCritical', 'vehicleId'], defaultSort: { field: 'scheduledAt', dir: 'desc' } })
    const scope = new DataScope(p)
    const db = this.prisma.db
    const [orders, vehicles] = await Promise.all([db.maintenanceOrder.findMany(), db.vehicle.findMany({ select: { id: true, baseId: true, fleetId: true } })])
    const visible = new Set(vehicles.filter((v) => scope.covers(v.baseId, v.fleetId)).map((v) => v.id))
    const items = orders.filter((m) => visible.has(m.vehicleId)).map((m) => this.read.maintenanceView(m))
    const openCritical = (m: { critical: boolean; status: string }) => m.critical && !['Completada', 'Cerrada', 'Cancelada'].includes(m.status)
    return pageInMemory(items, q, {
      search: (m) => `${m.code} ${m.vehiclePlate} ${m.description}`,
      filters: { status: (m, v) => m.status === v, kind: (m, v) => m.kind === v, critical: (m, v) => String(m.critical) === v, openCritical: (m, v) => String(openCritical(m)) === v, vehicleId: (m, v) => m.vehicleId === v },
      facets: { status: (m) => m.status, kind: (m) => m.kind, openCritical: (m) => String(openCritical(m)) },
      sort: { code: (m) => m.code, vehiclePlate: (m) => m.vehiclePlate, scheduledAt: (m) => m.scheduledAt, status: (m) => m.status, kind: (m) => m.kind },
    })
  }

  async createMaintenance(p: Principal, dto: MaintenanceDto) {
    const at = parseDate(dto.scheduledAt)
    if (!at) throw Errors.field('scheduledAt', 'Fecha inválida.')
    return this.prisma.tx(async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id: dto.vehicleId, ...this.vehicleScope(p) } })
      if (!v) throw Errors.field('vehicleId', 'El vehículo no existe o está fuera de su alcance.')
      const code = await this.counters.next(tx, p.tenantId as string, 'maintenance')
      const m = await tx.maintenanceOrder.create({
        data: { tenantId: p.tenantId as string, code, vehicleId: v.id, vehiclePlate: v.plate, kind: MAINT_KIND.parse(dto.kind)!, scheduledAt: at, description: clean(dto.description), critical: dto.critical, createdBy: p.name },
      })
      await this.audit.record({ resourceType: 'Mantenimiento', resourceId: m.code, action: 'maintenance.create', after: `${dto.kind}${dto.critical ? ' (crítica)' : ''} · ${v.plate}` }, tx)
      return this.read.maintenanceView(m)
    })
  }

  async updateMaintenance(p: Principal, id: string, dto: UpdateMaintenanceDto) {
    const at = parseDate(dto.scheduledAt)
    if (!at) throw Errors.field('scheduledAt', 'Fecha inválida.')
    return this.prisma.tx(async (tx) => {
      const m = await tx.maintenanceOrder.findFirst({ where: { id } })
      if (!m || !(await tx.vehicle.findFirst({ where: { id: m.vehicleId, ...this.vehicleScope(p) }, select: { id: true } }))) throw Errors.unavailable()
      if (!['PENDIENTE', 'PROGRAMADA'].includes(m.status)) throw Errors.conflict('Orden no editable', `Una orden «${MAINT_STATUS.label(m.status)}» ya no se puede editar; el historial se conserva.`)
      const next = await tx.maintenanceOrder.update({ where: { id }, data: { scheduledAt: at, description: clean(dto.description), critical: dto.critical, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Mantenimiento', resourceId: m.code, action: 'maintenance.update', before: `${m.description} · ${m.critical ? 'crítica' : 'normal'}`, after: `${next.description} · ${next.critical ? 'crítica' : 'normal'}` }, tx)
      return this.read.maintenanceView(next)
    })
  }

  async advanceMaintenance(p: Principal, id: string, dto: AdvanceMaintenanceDto) {
    const to = MAINT_STATUS.parse(dto.to)
    if (!to) throw Errors.field('to', 'Estado inválido.')
    return this.prisma.tx(async (tx) => {
      const m = await tx.maintenanceOrder.findFirst({ where: { id } })
      const v = m ? await tx.vehicle.findFirst({ where: { id: m.vehicleId, ...this.vehicleScope(p) } }) : null
      if (!m || !v) throw Errors.unavailable()
      if (!MAINT_FLOW[m.status]?.includes(to)) throw Errors.conflict('Transición inválida', `No se puede pasar de «${MAINT_STATUS.label(m.status)}» a «${dto.to}».`)
      if (to === 'CANCELADA' && clean(dto.reason).length < 5) throw Errors.field('reason', 'Indique el motivo de cancelación (mín. 5 caracteres).')
      const data: Prisma.MaintenanceOrderUpdateInput = { status: to, version: { increment: 1 } }
      if (to === 'CANCELADA') data.cancelReason = clean(dto.reason)
      if (to === 'COMPLETADA') {
        if (m.kind === 'INSPECCION' && !dto.inspectionResult) throw Errors.field('inspectionResult', 'Registre el resultado de la inspección.')
        if (dto.odometerKm !== undefined) {
          if (dto.odometerKm < v.odometerKm) throw Errors.field('odometerKm', `Lectura inconsistente: menor al último odómetro aceptado (${km(v.odometerKm)}) — EXC-030.`)
          await tx.vehicle.update({ where: { id: v.id }, data: { odometerKm: dto.odometerKm, version: { increment: 1 } } })
          data.odometerKm = dto.odometerKm
        }
        if (dto.inspectionResult) data.inspectionResult = dto.inspectionResult === 'Aprobada' ? 'APROBADA' : 'RECHAZADA'
      }
      const next = await tx.maintenanceOrder.update({ where: { id }, data })
      await this.audit.record({ resourceType: 'Mantenimiento', resourceId: m.code, action: 'maintenance.advance', before: MAINT_STATUS.label(m.status), after: dto.to + (dto.inspectionResult ? ` · ${dto.inspectionResult}` : ''), reason: dto.reason ?? null }, tx)
      await this.promoteIfReady(tx, v.id)
      return this.read.maintenanceView(next)
    })
  }
}
