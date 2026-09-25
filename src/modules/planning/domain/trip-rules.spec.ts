import { peakOccupancy, routeStops, seatsTakenIn, spanOf } from './stops'
import { TRIP_ACTION_RULES, tripConditions, windowsOverlap } from './trip-rules'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const base = { lifecycle: 'EN_RUTA' as const, plannedEta: new Date(NOW + 3_600_000), etaUpdated: null, openAlertKinds: [], openAlertSeverities: [], openIncidents: 0, emergency: false, now: NOW, delayToleranceMs: 15 * 60_000 }

describe('Matriz de transición del viaje (PROC-003)', () => {
  it('cada acción solo parte de los estados permitidos por DOC-A', () => {
    expect(TRIP_ACTION_RULES.enable.from).toEqual(['ASIGNADO'])
    expect(TRIP_ACTION_RULES.dispatch.from).toEqual(['LISTO_PARA_SALIDA'])
    expect(TRIP_ACTION_RULES.close.from).toEqual(['EN_DESTINO'])
    expect(TRIP_ACTION_RULES.cancel.from).not.toContain('EN_RUTA')
    expect(TRIP_ACTION_RULES.interrupt.from).toEqual(['EN_RUTA'])
    expect(TRIP_ACTION_RULES.reschedule.perm).toBe('trip.reassign')
  })
})

describe('Condiciones derivadas (DEC-002)', () => {
  it('sin alertas ni incidencias no hay condiciones', () => {
    expect(tripConditions(base)).toEqual([])
  })
  it('retraso por alerta o por ETA superada más tolerancia (CTRL-008)', () => {
    expect(tripConditions({ ...base, openAlertKinds: ['RETRASO'] })).toContain('Retrasado')
    expect(tripConditions({ ...base, plannedEta: new Date(NOW - 20 * 60_000) })).toContain('Retrasado')
    expect(tripConditions({ ...base, plannedEta: new Date(NOW - 10 * 60_000) })).not.toContain('Retrasado')
  })
  it('alerta Alta o emergencia ⇒ En riesgo; incidencia ⇒ Con incidencia', () => {
    expect(tripConditions({ ...base, openAlertKinds: ['EXCESO_VELOCIDAD'], openAlertSeverities: ['ALTA'] })).toEqual(expect.arrayContaining(['Con alerta', 'En riesgo']))
    expect(tripConditions({ ...base, openIncidents: 1, emergency: true })).toEqual(expect.arrayContaining(['Con incidencia', 'En riesgo']))
  })
  it('RN-002: ventanas superpuestas (tocarse en el borde no es superponerse)', () => {
    const w = (a: number, b: number) => ({ dep: new Date(a), eta: new Date(b) })
    expect(windowsOverlap(w(0, 10), w(5, 15))).toBe(true)
    expect(windowsOverlap(w(0, 10), w(10, 20))).toBe(false)
  })
})

describe('Tramos y asientos (PC-A6 · RN-003)', () => {
  const pts = [
    { name: 'Lima', lat: 0, lon: 0, stop: 'Sube' as const },
    { name: 'Huacho', lat: 0, lon: 1, stop: 'Sube y baja' as const },
    { name: 'Peaje', lat: 0, lon: 2, stop: null },
    { name: 'Trujillo', lat: 0, lon: 3, stop: 'Baja' as const },
  ]
  const stops = routeStops(pts)
  it('solo los puntos marcados son paradas; sin paradas el viaje es directo', () => {
    expect(stops.map((s) => s.name)).toEqual(['Lima', 'Huacho', 'Trujillo'])
    expect(routeStops(pts.map((p) => ({ ...p, stop: null }))).map((s) => s.name)).toEqual(['Lima', 'Trujillo'])
  })
  it('un asiento se reutiliza cuando su pasajero ya bajó', () => {
    const items = [{ id: 'a', seat: 1, status: 'RESERVADA', boardStop: 'Lima', alightStop: 'Huacho' }]
    expect(seatsTakenIn(stops, items, spanOf(stops, 'Huacho', 'Trujillo')).has(1)).toBe(false)
    expect(seatsTakenIn(stops, items, spanOf(stops, 'Lima', 'Trujillo')).has(1)).toBe(true)
  })
  it('ocupación máxima por tramo (KPI-010) y cancelados liberan asiento', () => {
    const items = [
      { id: 'a', seat: 1, status: 'RESERVADA', boardStop: 'Lima', alightStop: 'Huacho' },
      { id: 'b', seat: 1, status: 'ABORDO', boardStop: 'Huacho', alightStop: 'Trujillo' },
      { id: 'c', seat: 2, status: 'CANCELADA', boardStop: 'Lima', alightStop: 'Trujillo' },
    ]
    expect(peakOccupancy(stops, items)).toBe(1)
  })
})
