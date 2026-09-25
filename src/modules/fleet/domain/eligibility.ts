/**
 * Reglas de elegibilidad (RF-005 · RN-009 · CTRL-004/005/022 · DEC-002). Funciones PURAS: sin BD ni reloj implícito,
 * para que el gate, las listas, el panel y las pruebas usen exactamente la misma regla.
 * Lifecycle (estado de vida) ≠ condiciones (hechos paralelos) ≠ elegibilidad (conclusión para operar).
 */
export type Eligibility = 'Elegible' | 'Condicionado' | 'No habilitado'
export type VehicleCondition = 'En mantenimiento' | 'Bloqueado' | 'Fuera de servicio' | 'Con incidencia' | 'Documento vencido'
export type DriverCondition = 'Licencia vencida' | 'Restricción' | 'Capacitación pendiente' | 'Aptitud pendiente'
export type DocumentPhase = 'Vigente' | 'Por vencer' | 'Vencido' | 'Reemplazado'

const MS_DAY = 86_400_000

export interface DocFacts {
  docType: string
  expiresAt: Date
  critical: boolean
  replaced: boolean
}

export function documentPhase(d: Pick<DocFacts, 'expiresAt' | 'replaced'>, now: number, expiringDays: number): DocumentPhase {
  if (d.replaced) return 'Reemplazado'
  const left = (d.expiresAt.getTime() - now) / MS_DAY
  if (left < 0) return 'Vencido'
  if (left <= expiringDays) return 'Por vencer'
  return 'Vigente'
}

export interface MaintFacts {
  code: string
  kind: 'PREVENTIVO' | 'CORRECTIVO' | 'INSPECCION'
  status: 'PENDIENTE' | 'PROGRAMADA' | 'EN_EJECUCION' | 'COMPLETADA' | 'CERRADA' | 'CANCELADA'
  critical: boolean
  scheduledAt: Date
  inspectionResult: 'APROBADA' | 'RECHAZADA' | null
}

const MAINT_OPEN = new Set(['PENDIENTE', 'PROGRAMADA', 'EN_EJECUCION'])

/** Mantenimiento crítico que YA debió ejecutarse y sigue abierto (una orden futura aún no bloquea). */
export const openCriticalMaintenance = (orders: MaintFacts[], now: number) =>
  orders.filter((m) => m.critical && MAINT_OPEN.has(m.status) && m.scheduledAt.getTime() <= now)

export const lastInspection = (orders: MaintFacts[]) =>
  orders.filter((m) => m.kind === 'INSPECCION' && m.inspectionResult).sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())[0]

export interface VehicleFacts {
  blocked: boolean
  blockReason: string | null
  outOfService: boolean
  docs: DocFacts[]
  maintenance: MaintFacts[]
  hasOpenIncident: boolean
}

export interface EligibilityResult<C> {
  conditions: C[]
  eligibility: Eligibility
  reasons: string[]
}

export function evaluateVehicle(v: VehicleFacts, now: number, expiringDays: number): EligibilityResult<VehicleCondition> {
  const live = v.docs.filter((d) => !d.replaced)
  const expired = live.filter((d) => d.critical && documentPhase(d, now, expiringDays) === 'Vencido')
  const expiring = live.filter((d) => documentPhase(d, now, expiringDays) === 'Por vencer')
  const maint = openCriticalMaintenance(v.maintenance, now)
  const ins = lastInspection(v.maintenance)
  const conditions: VehicleCondition[] = []
  if (maint.length) conditions.push('En mantenimiento')
  if (v.blocked) conditions.push('Bloqueado')
  if (v.outOfService) conditions.push('Fuera de servicio')
  if (v.hasOpenIncident) conditions.push('Con incidencia')
  if (expired.length) conditions.push('Documento vencido')
  const reasons: string[] = []
  if (v.blocked) reasons.push(`Bloqueado: ${v.blockReason ?? 'sin motivo registrado'}`)
  if (v.outOfService) reasons.push('Fuera de servicio')
  if (maint.length) reasons.push(`Mantenimiento crítico pendiente (${maint.map((m) => m.code).join(', ')})`)
  if (expired.length) reasons.push(`Documento crítico vencido: ${expired.map((d) => d.docType).join(', ')}`)
  if (ins?.inspectionResult === 'RECHAZADA') reasons.push('Última inspección rechazada')
  let eligibility: Eligibility = reasons.length ? 'No habilitado' : 'Elegible'
  if (eligibility === 'Elegible' && expiring.length) {
    eligibility = 'Condicionado'
    reasons.push(`Documento por vencer: ${expiring.map((d) => d.docType).join(', ')}`)
  }
  return { conditions, eligibility, reasons }
}

export interface DriverFacts {
  licenseExpiry: Date
  restrictions: string
  trainingPending: boolean
  aptitudePending: boolean
  inactive: boolean
}

export function evaluateDriver(d: DriverFacts, now: number, expiringDays: number): EligibilityResult<DriverCondition> {
  const left = (d.licenseExpiry.getTime() - now) / MS_DAY
  const conditions: DriverCondition[] = []
  if (left < 0) conditions.push('Licencia vencida')
  if (d.restrictions) conditions.push('Restricción')
  if (d.trainingPending) conditions.push('Capacitación pendiente')
  if (d.aptitudePending) conditions.push('Aptitud pendiente')
  const reasons: string[] = []
  if (d.inactive) reasons.push('Conductor inactivo')
  if (left < 0) reasons.push('Licencia vencida')
  else if (left <= expiringDays) reasons.push(`Licencia vence en ${Math.ceil(left)} días`)
  if (d.trainingPending) reasons.push('Capacitación pendiente')
  if (d.aptitudePending) reasons.push('Aptitud pendiente')
  if (d.restrictions) reasons.push(`Restricción: ${d.restrictions}`)
  const eligibility: Eligibility = left < 0 || d.inactive ? 'No habilitado' : reasons.length ? 'Condicionado' : 'Elegible'
  return { conditions, eligibility, reasons }
}

/** Lifecycle visible del vehículo: el persistido (Registrado/Disponible) + lo que derivan sus viajes abiertos. */
export function vehicleLifecycle(stored: 'REGISTRADO' | 'DISPONIBLE' | 'ASIGNADO' | 'EN_OPERACION', openTrips: string[]): 'Registrado' | 'Disponible' | 'Asignado' | 'En operación' {
  if (openTrips.some((l) => l === 'EN_RUTA' || l === 'EN_DESTINO')) return 'En operación'
  if (openTrips.some((l) => l === 'ASIGNADO' || l === 'LISTO_PARA_SALIDA')) return 'Asignado'
  return stored === 'REGISTRADO' ? 'Registrado' : 'Disponible'
}

export function driverLifecycle(d: DriverFacts, now: number, openTrips: string[]): 'Elegible' | 'Asignado' | 'No elegible' | 'Inactivo' {
  if (d.inactive) return 'Inactivo'
  if (d.licenseExpiry.getTime() < now) return 'No elegible'
  if (openTrips.some((l) => ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA'].includes(l))) return 'Asignado'
  return 'Elegible'
}
