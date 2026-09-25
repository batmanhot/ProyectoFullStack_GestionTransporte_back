import { evaluateGate, type GateInput } from './gate'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const day = (d: number) => new Date(NOW + d * 86_400_000)

const vehicle = (over: Partial<NonNullable<GateInput['vehicle']>> = {}): NonNullable<GateInput['vehicle']> => ({
  plate: 'BUS-101', gpsDeviceId: 'GPS-1', capacityKg: 1000, capacityPassengers: 40, blocked: false, blockReason: null, outOfService: false, hasOpenIncident: false,
  docs: [{ docType: 'SOAT', expiresAt: day(200), critical: true, replaced: false }], maintenance: [], ...over,
})
const driver = (over: Partial<NonNullable<GateInput['driver']>> = {}): NonNullable<GateInput['driver']> => ({
  name: 'Carlos', licenseExpiry: day(300), restrictions: '', trainingPending: false, aptitudePending: false, inactive: false, ...over,
})
const input = (over: Partial<GateInput> = {}): GateInput => ({
  tripId: 't1', vehicle: vehicle(), driver: driver(), route: { name: 'Lima – Trujillo', version: 1, status: 'AUTORIZADA' }, cargoKg: null, passengerPeak: null, now: NOW, expiringDays: 30, ...over,
})
const req = (g: ReturnType<typeof evaluateGate>, id: string) => g.requirements.find((r) => r.id === id)!

describe('Gate CTRL-001', () => {
  it('habilita cuando todos los requisitos críticos y advertencias cumplen', () => {
    expect(evaluateGate(input()).overall).toBe('Habilitado')
  })

  it('sin vehículo ni conductor: No habilitado, explicando cada requisito y su responsable', () => {
    const g = evaluateGate(input({ vehicle: null, driver: null }))
    expect(g.overall).toBe('No habilitado')
    expect(req(g, 'VEH-01')).toMatchObject({ status: 'Falla', fixOwner: 'Supervisor de flota (ROL-004)' })
    expect(req(g, 'CON-01').status).toBe('Falla')
    expect(req(g, 'DOC-02').status).toBe('Falla')
  })

  it('documento crítico vencido bloquea (RN-009) aunque el resto cumpla', () => {
    const g = evaluateGate(input({ vehicle: vehicle({ docs: [{ docType: 'Revisión técnica', expiresAt: day(-1), critical: true, replaced: false }] }) }))
    expect(g.overall).toBe('No habilitado')
    expect(req(g, 'DOC-01').detail).toContain('Revisión técnica vencido')
  })

  it('un documento reemplazado ya no cuenta', () => {
    const g = evaluateGate(input({ vehicle: vehicle({ docs: [{ docType: 'SOAT', expiresAt: day(-10), critical: true, replaced: true }] }) }))
    expect(req(g, 'DOC-01').status).toBe('Cumple')
  })

  it('una advertencia NUNCA compensa un crítico fallido', () => {
    const g = evaluateGate(input({ vehicle: vehicle({ gpsDeviceId: null, blocked: true, blockReason: 'frenos' }) }))
    expect(req(g, 'ADV-03').status).toBe('Falla')
    expect(g.overall).toBe('No habilitado')
  })

  it('solo advertencias ⇒ Habilitado con advertencias (EXC-007 sin GPS)', () => {
    expect(evaluateGate(input({ vehicle: vehicle({ gpsDeviceId: null }) })).overall).toBe('Habilitado con advertencias')
  })

  it('mantenimiento crítico vencido bloquea; uno futuro todavía no', () => {
    const m = (d: number) => ({ code: 'OT-1', kind: 'CORRECTIVO' as const, status: 'PROGRAMADA' as const, critical: true, scheduledAt: day(d), inspectionResult: null })
    expect(req(evaluateGate(input({ vehicle: vehicle({ maintenance: [m(-1)] }) })), 'MAN-01').status).toBe('Falla')
    expect(req(evaluateGate(input({ vehicle: vehicle({ maintenance: [m(2)] }) })), 'MAN-01').status).toBe('Cumple')
  })

  it('la última inspección rechazada bloquea (EXC-029)', () => {
    const ins = { code: 'OT-2', kind: 'INSPECCION' as const, status: 'COMPLETADA' as const, critical: false, scheduledAt: day(-2), inspectionResult: 'RECHAZADA' as const }
    expect(req(evaluateGate(input({ vehicle: vehicle({ maintenance: [ins] }) })), 'INS-01').status).toBe('Falla')
  })

  it('ruta obsoleta bloquea (RF-009)', () => {
    expect(req(evaluateGate(input({ route: { name: 'R', version: 1, status: 'OBSOLETA' } })), 'RUT-01').status).toBe('Falla')
  })

  it('capacidad (RN-003/RN-004): no aplica sin carga ni pasajeros; falla si se excede', () => {
    expect(req(evaluateGate(input()), 'CAP-01').status).toBe('No aplica')
    expect(req(evaluateGate(input({ cargoKg: 900 })), 'CAP-01').status).toBe('Cumple')
    expect(req(evaluateGate(input({ cargoKg: 1200 })), 'CAP-01').status).toBe('Falla')
    expect(req(evaluateGate(input({ passengerPeak: 41 })), 'CAP-01').status).toBe('Falla')
  })

  it('licencia vencida del conductor bloquea', () => {
    expect(evaluateGate(input({ driver: driver({ licenseExpiry: day(-1) }) })).overall).toBe('No habilitado')
  })
})
