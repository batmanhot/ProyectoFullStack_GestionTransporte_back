import { isolateArgs, TenantIsolationError, TENANT_SCOPED_MODELS } from './tenant-isolation.extension'

const T = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

describe('Aislamiento de tenant centralizado (ADR-005 · RN-010)', () => {
  it('agrega el tenant de la sesión a toda lectura/escritura con where', () => {
    for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'updateMany', 'deleteMany', 'aggregate', 'groupBy']) {
      expect(isolateArgs('Vehicle', op, { where: { plate: 'X' } }, T)).toEqual({ where: { plate: 'X', tenantId: T } })
    }
  })

  it('fija el tenant en creaciones (una o muchas) y en upsert', () => {
    expect(isolateArgs('Trip', 'create', { data: { code: 'VJ-1' } }, T)).toEqual({ data: { code: 'VJ-1', tenantId: T } })
    expect(isolateArgs('Trip', 'createMany', { data: [{ code: 'a' }, { code: 'b' }] }, T)).toEqual({ data: [{ code: 'a', tenantId: T }, { code: 'b', tenantId: T }] })
    expect(isolateArgs('ClientProfile', 'upsert', { where: { x: 1 }, create: { a: 1 }, update: {} }, T)).toMatchObject({ where: { x: 1, tenantId: T }, create: { a: 1, tenantId: T } })
  })

  it('rechaza filtros o escrituras con OTRO tenant (EXC-001)', () => {
    expect(() => isolateArgs('Vehicle', 'findMany', { where: { tenantId: OTHER } }, T)).toThrow(TenantIsolationError)
    expect(() => isolateArgs('Vehicle', 'create', { data: { tenantId: OTHER } }, T)).toThrow(TenantIsolationError)
  })

  it('fail-closed: sin tenant en contexto no se toca un modelo de negocio', () => {
    expect(() => isolateArgs('Alert', 'findMany', {}, null)).toThrow(/fail-closed/)
  })

  it('no altera modelos de plataforma (tenant, sesiones, ajustes)', () => {
    expect(isolateArgs('Tenant', 'findMany', { where: { slug: 'a' } }, null)).toEqual({ where: { slug: 'a' } })
    expect(TENANT_SCOPED_MODELS.has('AuthSession')).toBe(false)
    expect(TENANT_SCOPED_MODELS.has('PlatformSettings')).toBe(false)
  })

  it('todo modelo con datos de negocio está cubierto', () => {
    for (const m of ['Vehicle', 'Driver', 'Trip', 'Alert', 'Incident', 'CargoShipment', 'PassengerBooking', 'AuditEvent', 'StoredFile', 'Notification', 'User']) {
      expect(TENANT_SCOPED_MODELS.has(m)).toBe(true)
    }
  })
})
