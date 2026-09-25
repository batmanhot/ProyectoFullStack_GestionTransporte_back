import { documentPhase, evaluateDriver, evaluateVehicle, lastInspection, openCriticalMaintenance, type DocFacts, type DriverFacts, type MaintFacts } from '../../fleet/domain/eligibility'

/**
 * Gate CTRL-001 · Habilitación operacional de viaje (PROC-003 · RN-001 · RF-012). Función PURA.
 * Resultado: Habilitado / Habilitado con advertencias / No habilitado. Una advertencia NUNCA compensa un crítico fallido.
 * Cada requisito dice qué falla, quién lo corrige (fixOwner) y qué regla lo exige.
 */
export type GateOverall = 'Habilitado' | 'Habilitado con advertencias' | 'No habilitado'
export interface GateRequirement {
  id: string
  category: 'Vehículo' | 'Conductor' | 'Documentación' | 'Mantenimiento' | 'Inspección' | 'Ruta' | 'Capacidad' | 'Manifiestos'
  label: string
  severity: 'Crítico' | 'Advertencia'
  status: 'Cumple' | 'Falla' | 'No aplica'
  detail: string
  fixOwner: string
  rule: string
}
export interface GateResult {
  tripId: string
  evaluatedAt: string
  overall: GateOverall
  requirements: GateRequirement[]
}

export interface GateInput {
  tripId: string
  vehicle: (DriverFactsFree & { plate: string; gpsDeviceId: string | null; capacityKg: number; capacityPassengers: number; docs: DocFacts[]; maintenance: MaintFacts[] }) | null
  driver: (DriverFacts & { name: string }) | null
  route: { name: string; version: number; status: 'BORRADOR' | 'AUTORIZADA' | 'OBSOLETA' } | null
  /** Carga asignada que ocupa el vehículo (kg). `null` = el viaje no lleva carga. */
  cargoKg: number | null
  /** Máximo de asientos ocupados a la vez en algún tramo. `null` = el viaje no lleva pasajeros. */
  passengerPeak: number | null
  now: number
  expiringDays: number
}

interface DriverFactsFree {
  blocked: boolean
  blockReason: string | null
  outOfService: boolean
  hasOpenIncident: boolean
}

const d10 = (d: Date) => d.toISOString().slice(0, 10)

export function evaluateGate(i: GateInput): GateResult {
  const reqs: GateRequirement[] = []
  const R = (r: GateRequirement) => reqs.push(r)
  const v = i.vehicle
  const d = i.driver
  const vEval = v ? evaluateVehicle(v, i.now, i.expiringDays) : null
  const dEval = d ? evaluateDriver(d, i.now, i.expiringDays) : null

  R({
    id: 'VEH-01', category: 'Vehículo', label: 'Vehículo asignado y elegible', severity: 'Crítico', rule: 'RN-009 · RF-005', fixOwner: 'Supervisor de flota (ROL-004)',
    status: !vEval || vEval.eligibility === 'No habilitado' ? 'Falla' : 'Cumple',
    detail: !v || !vEval ? 'No hay vehículo asignado.' : vEval.eligibility === 'No habilitado' ? vEval.reasons.join(' · ') : `${v.plate}: ${vEval.eligibility}`,
  })
  R({
    id: 'CON-01', category: 'Conductor', label: 'Conductor asignado y elegible', severity: 'Crítico', rule: 'RN-002 · RF-005', fixOwner: 'Jefe de transporte (ROL-003)',
    status: !dEval || dEval.eligibility === 'No habilitado' ? 'Falla' : 'Cumple',
    detail: !d || !dEval ? 'No hay conductor asignado.' : dEval.eligibility === 'No habilitado' ? dEval.reasons.join(' · ') : `${d.name}: ${dEval.eligibility}`,
  })
  const liveDocs = v ? v.docs.filter((x) => !x.replaced) : []
  const expired = liveDocs.filter((x) => x.critical && documentPhase(x, i.now, i.expiringDays) === 'Vencido')
  R({
    id: 'DOC-01', category: 'Documentación', label: 'Documentos críticos del vehículo vigentes', severity: 'Crítico', rule: 'CTRL-004 · RN-009', fixOwner: 'Responsable de mantenimiento (ROL-009)',
    status: !v || expired.length ? 'Falla' : 'Cumple',
    detail: !v ? 'No hay vehículo asignado.' : expired.length ? expired.map((x) => `${x.docType} vencido el ${d10(x.expiresAt)}`).join(' · ') : 'Sin documentos críticos vencidos.',
  })
  const licOk = !!d && d.licenseExpiry.getTime() > i.now
  R({
    id: 'DOC-02', category: 'Documentación', label: 'Licencia del conductor vigente', severity: 'Crítico', rule: 'CTRL-004', fixOwner: 'Jefe de transporte (ROL-003)',
    status: licOk ? 'Cumple' : 'Falla', detail: licOk && d ? `Vigente hasta ${d10(d.licenseExpiry)}.` : 'Licencia vencida o conductor sin asignar.',
  })
  const mc = v ? openCriticalMaintenance(v.maintenance, i.now) : []
  R({
    id: 'MAN-01', category: 'Mantenimiento', label: 'Sin mantenimiento crítico pendiente', severity: 'Crítico', rule: 'RN-009 · CTRL-022', fixOwner: 'Responsable de mantenimiento (ROL-009)',
    status: mc.length ? 'Falla' : 'Cumple', detail: mc.length ? `Órdenes: ${mc.map((m) => m.code).join(', ')}` : 'Sin órdenes críticas abiertas.',
  })
  const ins = v ? lastInspection(v.maintenance) : undefined
  R({
    id: 'INS-01', category: 'Inspección', label: 'Última inspección aprobada', severity: 'Crítico', rule: 'CTRL-022 · EXC-029', fixOwner: 'Responsable de mantenimiento (ROL-009)',
    status: ins?.inspectionResult === 'RECHAZADA' ? 'Falla' : 'Cumple',
    detail: ins ? `${ins.code}: ${ins.inspectionResult === 'RECHAZADA' ? 'Rechazada' : 'Aprobada'}` : 'Sin inspección registrada que bloquee.',
  })
  R({
    id: 'RUT-01', category: 'Ruta', label: 'Ruta autorizada y vigente', severity: 'Crítico', rule: 'RF-009', fixOwner: 'Programador de rutas (ROL-005)',
    status: i.route?.status === 'AUTORIZADA' ? 'Cumple' : 'Falla',
    detail: i.route ? `${i.route.name} · v${i.route.version} · ${i.route.status === 'AUTORIZADA' ? 'Autorizada' : i.route.status === 'OBSOLETA' ? 'Obsoleta' : 'Borrador'}` : 'Ruta inexistente.',
  })
  // RN-003/RN-004 (CONFIRMADAS en DOC-A): la capacidad se vuelve a validar al habilitar, p. ej. si una reasignación cambió el vehículo.
  if (i.cargoKg === null && i.passengerPeak === null) {
    R({ id: 'CAP-01', category: 'Capacidad', label: 'Capacidad de carga/pasajeros', severity: 'Crítico', rule: 'RN-003 · RN-004', status: 'No aplica', fixOwner: '—', detail: 'El viaje no lleva carga ni pasajeros registrados.' })
  } else {
    const over: string[] = []
    if (v && i.cargoKg !== null && i.cargoKg > v.capacityKg) over.push(`carga ${i.cargoKg} kg > ${v.capacityKg} kg`)
    if (v && i.passengerPeak !== null && i.passengerPeak > v.capacityPassengers) over.push(`pasajeros ${i.passengerPeak} > ${v.capacityPassengers} asientos`)
    R({
      id: 'CAP-01', category: 'Capacidad', label: 'Capacidad de carga/pasajeros', severity: 'Crítico', rule: 'RN-003 · RN-004 · EXC-015/019', fixOwner: 'Despachador (ROL-006)',
      status: !v || over.length ? 'Falla' : 'Cumple',
      detail: !v ? 'No hay vehículo para validar la capacidad.' : over.length ? `Capacidad excedida: ${over.join(' · ')}.` : 'Dentro de la capacidad del vehículo.',
    })
  }
  // Completitud de manifiestos: la política de aprobación de excepciones es GAP-007 ⇒ no se automatiza una regla inventada.
  R({ id: 'MFT-01', category: 'Manifiestos', label: 'Manifiestos aplicables', severity: 'Crítico', rule: 'PROC-005/006 · GAP-007', status: 'No aplica', fixOwner: '—', detail: 'La política de completitud de manifiestos está pendiente (GAP-007).' })

  const expiring = liveDocs.filter((x) => documentPhase(x, i.now, i.expiringDays) === 'Por vencer')
  R({
    id: 'ADV-01', category: 'Documentación', label: 'Documentos próximos a vencer', severity: 'Advertencia', rule: 'CTRL-005', fixOwner: 'Supervisor de flota (ROL-004)',
    status: expiring.length ? 'Falla' : 'Cumple', detail: expiring.length ? expiring.map((x) => `${x.docType} vence ${d10(x.expiresAt)}`).join(' · ') : 'Ninguno.',
  })
  const pend = d ? [d.trainingPending && 'Capacitación pendiente', d.aptitudePending && 'Aptitud pendiente'].filter(Boolean) : []
  R({
    id: 'ADV-02', category: 'Conductor', label: 'Capacitación / aptitud del conductor', severity: 'Advertencia', rule: 'RF-004', fixOwner: 'Jefe de transporte (ROL-003)',
    status: pend.length ? 'Falla' : 'Cumple', detail: pend.length ? pend.join(' · ') : 'Al día.',
  })
  R({
    id: 'ADV-03', category: 'Vehículo', label: 'Dispositivo GPS asociado', severity: 'Advertencia', rule: 'EXC-007', fixOwner: 'Supervisor de flota (ROL-004)',
    status: v && !v.gpsDeviceId ? 'Falla' : 'Cumple',
    detail: v && !v.gpsDeviceId ? 'Sin GPS: no habrá ubicación en el mapa (se mostrará "No disponible").' : 'Dispositivo asociado.',
  })

  const critFail = reqs.some((r) => r.severity === 'Crítico' && r.status === 'Falla')
  const warnFail = reqs.some((r) => r.severity === 'Advertencia' && r.status === 'Falla')
  return { tripId: i.tripId, evaluatedAt: new Date(i.now).toISOString(), overall: critFail ? 'No habilitado' : warnFail ? 'Habilitado con advertencias' : 'Habilitado', requirements: reqs }
}
