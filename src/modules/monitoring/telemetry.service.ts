import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { RequestContext } from '../../common/context/request-context'
import { Errors } from '../../common/errors/app-error'
import { PrismaService } from '../../database/prisma.service'
import { TokenService } from '../auth/token.service'
import { parsePoints } from '../planning/domain/stops'
import { RealtimePublisher } from '../realtime/realtime.publisher'
import { AlertEngine } from './alert.engine'
import { classifyFreshness, distanceToRouteM, routeProgress } from './domain/geo'

export const ARRIVING_PROGRESS = 0.9

export interface TelemetryInput {
  deviceId: string
  sourceTime: string
  lat: number
  lon: number
  speedKmh?: number | null
  heading?: number | null
  ignition?: boolean | null
  odometerKm?: number | null
}

export interface IngestResult {
  accepted: number
  duplicates: number
  outOfOrder: number
  rejected: { index: number; reason: string }[]
}

/** Tolerancia de reloj del dispositivo hacia el futuro (SUPUESTO TÉCNICO). */
const FUTURE_SKEW_MS = 2 * 60_000

/**
 * Ingesta de telemetría (INT-001 · RF-015 · PROC-004 SUB-008). Contrato NEUTRO de proveedor (ADR-015): el adaptador del
 * proveedor GPS elegido (pendiente, GAP-008) traduce su formato a este. Reglas:
 *  - EXC-014: dispositivo no asociado a un vehículo del tenant ⇒ se rechaza (no se inventa atribución).
 *  - EXC-011: evento repetido (vehículo + instante) ⇒ se ignora, sin duplicar.
 *  - EXC-012: evento más antiguo que la última posición ⇒ se conserva en historial, NO reemplaza la posición actual.
 *  - RN-006 / RF-018: exceso sobre el límite de la ruta + tolerancia (SPEED_TOLERANCE_PCT) ⇒ alerta idempotente por viaje.
 *  - RF-019: fuera del corredor de la ruta (ROUTE_CORRIDOR_METERS, SUPUESTO GAP-009) ⇒ alerta de desvío.
 */
@Injectable()
export class TelemetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertEngine,
    private readonly realtime: RealtimePublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get corridorM(): number {
    return this.config.ops.routeCorridorMeters
  }

  /** Resuelve el negocio a partir de la credencial de integración (nunca de un campo del cuerpo). */
  async tenantForKey(key: string | undefined): Promise<string> {
    if (!key || key.length < 24) throw Errors.unauthenticated('Credencial de integración inválida.')
    const cred = await this.prisma.system.integrationCredential.findUnique({ where: { keyHash: TokenService.hash(key) } })
    if (!cred || !cred.active || cred.kind !== 'telemetry') throw Errors.unauthenticated('Credencial de integración inválida.')
    const tenant = await this.prisma.system.tenant.findUnique({ where: { id: cred.tenantId }, select: { lifecycle: true } })
    if (!tenant || !['ACTIVO', 'REACTIVADO'].includes(tenant.lifecycle)) throw Errors.tenantInvalid('El negocio de esta integración no está operativo.')
    await this.prisma.system.integrationCredential.update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } })
    return cred.tenantId
  }

  async ingest(key: string | undefined, events: TelemetryInput[]): Promise<IngestResult> {
    const tenantId = await this.tenantForKey(key)
    return RequestContext.asTenant(tenantId, () => this.ingestForTenant(tenantId, events))
  }

  private async ingestForTenant(tenantId: string, events: TelemetryInput[]): Promise<IngestResult> {
    const db = this.prisma.db
    const result: IngestResult = { accepted: 0, duplicates: 0, outOfOrder: 0, rejected: [] }
    const devices = [...new Set(events.map((e) => e.deviceId))]
    const vehicles = await db.vehicle.findMany({ where: { gpsDeviceId: { in: devices } } })
    const byDevice = new Map(vehicles.map((v) => [v.gpsDeviceId as string, v]))
    const effects: (() => void)[] = []
    for (const [index, e] of events.entries()) {
      const v = byDevice.get(e.deviceId)
      if (!v) {
        result.rejected.push({ index, reason: 'Dispositivo no asociado a un vehículo de este negocio (EXC-014).' })
        continue
      }
      const at = new Date(e.sourceTime)
      if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + FUTURE_SKEW_MS) {
        result.rejected.push({ index, reason: 'Hora de origen inválida o en el futuro.' })
        continue
      }
      const outcome = await this.prisma.tx(async (tx) => {
        const inserted = await tx.telemetryEvent.createMany({
          data: [{ tenantId, vehicleId: v.id, deviceId: e.deviceId, sourceTime: at, lat: e.lat, lon: e.lon, speedKmh: e.speedKmh ?? null, heading: e.heading ?? null, ignition: e.ignition ?? null, odometerKm: e.odometerKm ?? null }],
          skipDuplicates: true,
        })
        if (inserted.count === 0) return 'duplicate' as const
        const last = await tx.vehicleLastPosition.findFirst({ where: { vehicleId: v.id } })
        if (last && last.sourceTime >= at) {
          await tx.telemetryEvent.updateMany({ where: { vehicleId: v.id, sourceTime: at }, data: { outOfOrder: true } })
          return 'outOfOrder' as const
        }
        const trip = await tx.trip.findFirst({ where: { vehicleId: v.id, lifecycle: 'EN_RUTA' } })
        const data = { tenantId, tripId: trip?.id ?? null, lat: e.lat, lon: e.lon, speedKmh: e.speedKmh ?? null, heading: e.heading ?? null, ignition: e.ignition ?? null, sourceTime: at }
        await tx.vehicleLastPosition.upsert({ where: { vehicleId: v.id }, create: { vehicleId: v.id, ...data }, update: data })
        // EXC-003: un odómetro menor al aceptado no se aplica (se conserva el evento como evidencia).
        if (e.odometerKm != null && e.odometerKm > v.odometerKm) await tx.vehicle.update({ where: { id: v.id }, data: { odometerKm: Math.round(e.odometerKm) } })
        if (trip) {
          const route = await tx.route.findFirst({ where: { id: trip.routeId } })
          const limit = route ? route.speedLimitKmh * (1 + this.config.ops.speedTolerancePct / 100) : null
          if (limit && e.speedKmh != null && e.speedKmh > limit) {
            const r = await this.alerts.raise(tx, {
              tenantId, kind: 'EXCESO_VELOCIDAD', severity: e.speedKmh > limit * 1.2 ? 'ALTA' : 'MEDIA', dedupeKey: `speed:${trip.id}`,
              detail: `${v.plate} a ${Math.round(e.speedKmh)} km/h (límite ${route!.speedLimitKmh} km/h + ${this.config.ops.speedTolerancePct}% de tolerancia).`,
              tripId: trip.id, tripCode: trip.code, vehicleId: v.id, vehiclePlate: v.plate, baseId: trip.baseId,
            })
            effects.push(...r.effects)
          }
          const pts = route ? parsePoints(route.points) : []
          if (pts.length >= 2) {
            const off = distanceToRouteM({ lat: e.lat, lon: e.lon }, pts)
            if (off > this.corridorM) {
              const r = await this.alerts.raise(tx, {
                tenantId, kind: 'DESVIO_RUTA', severity: off > this.corridorM * 3 ? 'ALTA' : 'MEDIA', dedupeKey: `route:${trip.id}`,
                detail: `${v.plate} está a ${(off / 1000).toFixed(1)} km del trazado autorizado de ${trip.routeName}.`,
                tripId: trip.id, tripCode: trip.code, vehicleId: v.id, vehiclePlate: v.plate, baseId: trip.baseId,
              })
              effects.push(...r.effects)
            }
          }
          // Recuperó señal: la alerta «Sin señal» se resuelve sola con evidencia técnica.
          await tx.alert.updateMany({ where: { dedupeKey: `signal:${trip.id}`, status: { in: ['NUEVA', 'RECONOCIDA', 'EN_GESTION'] } }, data: { status: 'RESUELTA', resolvedAt: new Date(), evidence: `Señal recuperada ${at.toISOString()}`, version: { increment: 1 } } })
        }
        // El FE reemplaza el ítem completo del mapa: el evento lleva la posición COMPLETA (mismo contrato que GET /tracking/positions).
        const fresh = classifyFreshness(at, Date.now(), this.config.ops.positionFreshSeconds)
        const [openKinds, emergency, route] = await Promise.all([
          tx.alert.findMany({ where: { vehicleId: v.id, status: { in: ['NUEVA', 'RECONOCIDA', 'EN_GESTION'] }, kind: { in: ['EXCESO_VELOCIDAD', 'RETRASO'] } }, select: { kind: true } }),
          tx.incident.count({ where: { vehicleId: v.id, emergency: true, status: { not: 'CERRADA' } } }),
          trip ? tx.route.findFirst({ where: { id: trip.routeId } }) : Promise.resolve(null),
        ])
        const pts = route ? parsePoints(route.points) : []
        const position = {
          vehicleId: v.id, plate: v.plate, tripId: trip?.id ?? null, tripCode: trip?.code ?? null, driverName: trip?.driverName ?? null,
          lat: e.lat, lon: e.lon, speedKmh: e.speedKmh ?? null, heading: e.heading ?? null, ignition: e.ignition ?? null, sourceTime: at.toISOString(), ...fresh,
          speeding: openKinds.some((a) => a.kind === 'EXCESO_VELOCIDAD'),
          emergency: emergency > 0,
          delayed: openKinds.some((a) => a.kind === 'RETRASO'),
          arriving: !!trip && pts.length >= 2 && routeProgress({ lat: e.lat, lon: e.lon }, pts) >= ARRIVING_PROGRESS,
          origin: route?.origin ?? null,
          destination: route?.destination ?? null,
        }
        effects.push(() => this.realtime.publish(tenantId, { type: 'position.updated', position }, { anyPerm: ['tracking.view'], baseId: trip?.baseId ?? v.baseId }))
        return 'accepted' as const
      })
      if (outcome === 'duplicate') result.duplicates++
      else if (outcome === 'outOfOrder') result.outOfOrder++
      else result.accepted++
    }
    effects.forEach((f) => f())
    return result
  }
}
