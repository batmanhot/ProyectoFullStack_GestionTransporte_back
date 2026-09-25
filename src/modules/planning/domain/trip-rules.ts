import type { TripLifecycle } from '../../../generated/prisma/client'

/**
 * Máquina de estados del viaje (DOC-A PROC-003, matriz de transición) y derivación de condiciones (DEC-002).
 * Funciones PURAS: la usan el servicio de viajes, la app del conductor y las pruebas.
 */
export type TripAction = 'enable' | 'dispatch' | 'arrival' | 'close' | 'cancel' | 'interrupt' | 'reassign' | 'reschedule'

export const TRIP_ACTION_RULES: Record<TripAction, { from: TripLifecycle[]; perm: string }> = {
  enable: { from: ['ASIGNADO'], perm: 'trip.enable' },
  dispatch: { from: ['LISTO_PARA_SALIDA'], perm: 'trip.dispatch' },
  arrival: { from: ['EN_RUTA'], perm: 'trip.arrival.record' },
  close: { from: ['EN_DESTINO'], perm: 'trip.close' },
  cancel: { from: ['PLANIFICADO', 'ASIGNADO', 'LISTO_PARA_SALIDA'], perm: 'trip.cancel' },
  interrupt: { from: ['EN_RUTA'], perm: 'trip.interrupt' },
  reassign: { from: ['ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA'], perm: 'trip.reassign' },
  reschedule: { from: ['PLANIFICADO', 'ASIGNADO'], perm: 'trip.reassign' },
}

/** Viajes que ocupan recursos (RN-002: sin superposición en la ventana planificada). */
export const RESOURCE_HOLDING: TripLifecycle[] = ['PLANIFICADO', 'ASIGNADO', 'LISTO_PARA_SALIDA', 'EN_RUTA', 'EN_DESTINO']
export const OPEN_TRIP: TripLifecycle[] = RESOURCE_HOLDING

export type TripCondition = 'Retrasado' | 'Con alerta' | 'Con incidencia' | 'Sin señal' | 'En riesgo'

export interface TripConditionFacts {
  lifecycle: TripLifecycle
  plannedEta: Date
  etaUpdated: Date | null
  openAlertKinds: string[]
  openAlertSeverities: string[]
  openIncidents: number
  emergency: boolean
  now: number
  delayToleranceMs: number
}

/**
 * Condiciones paralelas (no son estados): se DERIVAN de alertas/incidencias abiertas y del reloj, nunca se guardan
 * (una sola fuente de verdad: si la alerta se cierra, la condición desaparece sola).
 *  - Retrasado: alerta «Retraso» abierta, o en ruta con la ETA vigente superada más la tolerancia (CTRL-008).
 *  - En riesgo (SUPUESTO): alerta Alta/Crítica abierta o emergencia declarada.
 */
export function tripConditions(f: TripConditionFacts): TripCondition[] {
  const out: TripCondition[] = []
  const eta = (f.etaUpdated ?? f.plannedEta).getTime()
  if (f.openAlertKinds.includes('RETRASO') || (f.lifecycle === 'EN_RUTA' && f.now > eta + f.delayToleranceMs)) out.push('Retrasado')
  if (f.openAlertKinds.length) out.push('Con alerta')
  if (f.openIncidents > 0) out.push('Con incidencia')
  if (f.openAlertKinds.includes('SIN_SENAL')) out.push('Sin señal')
  if (f.emergency || f.openAlertSeverities.some((s) => s === 'ALTA' || s === 'CRITICA')) out.push('En riesgo')
  return out
}

/** Dos ventanas [salida, ETA) se superponen. */
export const windowsOverlap = (a: { dep: Date; eta: Date }, b: { dep: Date; eta: Date }) => a.dep < b.eta && b.dep < a.eta
