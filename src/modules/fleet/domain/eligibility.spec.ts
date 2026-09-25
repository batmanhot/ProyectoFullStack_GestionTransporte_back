import { documentPhase, driverLifecycle, evaluateDriver, evaluateVehicle, vehicleLifecycle } from './eligibility'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const day = (d: number) => new Date(NOW + d * 86_400_000)
const base = { blocked: false, blockReason: null, outOfService: false, docs: [], maintenance: [], hasOpenIncident: false }

describe('Elegibilidad de recursos (RF-005 · DEC-002)', () => {
  it('fase documental: vigente, por vencer (umbral configurable), vencido y reemplazado', () => {
    expect(documentPhase({ expiresAt: day(40), replaced: false }, NOW, 30)).toBe('Vigente')
    expect(documentPhase({ expiresAt: day(10), replaced: false }, NOW, 30)).toBe('Por vencer')
    expect(documentPhase({ expiresAt: day(-1), replaced: false }, NOW, 30)).toBe('Vencido')
    expect(documentPhase({ expiresAt: day(-1), replaced: true }, NOW, 30)).toBe('Reemplazado')
  })

  it('las condiciones son paralelas y no reemplazan al lifecycle', () => {
    const r = evaluateVehicle({ ...base, blocked: true, blockReason: 'frenos', outOfService: true, hasOpenIncident: true }, NOW, 30)
    expect(r.conditions).toEqual(expect.arrayContaining(['Bloqueado', 'Fuera de servicio', 'Con incidencia']))
    expect(r.eligibility).toBe('No habilitado')
  })

  it('documento por vencer ⇒ Condicionado (no bloquea)', () => {
    const r = evaluateVehicle({ ...base, docs: [{ docType: 'SOAT', expiresAt: day(5), critical: true, replaced: false }] }, NOW, 30)
    expect(r.eligibility).toBe('Condicionado')
  })

  it('documento NO crítico vencido no bloquea', () => {
    const r = evaluateVehicle({ ...base, docs: [{ docType: 'Póliza', expiresAt: day(-5), critical: false, replaced: false }] }, NOW, 30)
    expect(r.eligibility).toBe('Elegible')
  })

  it('conductor: licencia vencida o inactivo ⇒ No habilitado; pendientes ⇒ Condicionado', () => {
    const d = { licenseExpiry: day(100), restrictions: '', trainingPending: false, aptitudePending: false, inactive: false }
    expect(evaluateDriver(d, NOW, 30).eligibility).toBe('Elegible')
    expect(evaluateDriver({ ...d, trainingPending: true }, NOW, 30).eligibility).toBe('Condicionado')
    expect(evaluateDriver({ ...d, licenseExpiry: day(-1) }, NOW, 30).eligibility).toBe('No habilitado')
    expect(evaluateDriver({ ...d, inactive: true }, NOW, 30).eligibility).toBe('No habilitado')
  })

  it('lifecycle derivado de los viajes abiertos', () => {
    expect(vehicleLifecycle('DISPONIBLE', [])).toBe('Disponible')
    expect(vehicleLifecycle('REGISTRADO', [])).toBe('Registrado')
    expect(vehicleLifecycle('DISPONIBLE', ['ASIGNADO'])).toBe('Asignado')
    expect(vehicleLifecycle('DISPONIBLE', ['ASIGNADO', 'EN_RUTA'])).toBe('En operación')
    const d = { licenseExpiry: day(100), restrictions: '', trainingPending: false, aptitudePending: false, inactive: false }
    expect(driverLifecycle(d, NOW, ['LISTO_PARA_SALIDA'])).toBe('Asignado')
    expect(driverLifecycle({ ...d, inactive: true }, NOW, ['EN_RUTA'])).toBe('Inactivo')
  })
})
