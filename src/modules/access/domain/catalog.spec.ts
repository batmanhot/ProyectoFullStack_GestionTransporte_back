import { shouldDeliver } from '../../realtime/realtime.gateway'
import type { RealtimeEnvelope } from '../../realtime/realtime.publisher'
import { matchesSignature, safeFileName } from '../../files/files.service'
import { classifyFreshness, distanceToRouteM, haversineM } from '../../monitoring/domain/geo'
import { BASE_ROLE_PERMISSIONS, PERM_ID, PERMISSIONS, ROLE_IDS } from './catalog'
import type { Principal } from './principal'
import { DataScope } from './scope'

describe('Matriz rol→permiso (DOC-A §J.2)', () => {
  it('PERM-### conserva la numeración de DOC-A', () => {
    expect(PERM_ID['platform.tenant.manage']).toBe('PERM-001')
    expect(PERM_ID['driver.manage']).toBe('PERM-005')
    expect(PERM_ID['report.export']).toBe('PERM-027')
    expect(PERM_ID['dispatch.message']).toBe('PERM-029')
  })
  it('ningún permiso queda huérfano (PC-A4: driver.manage lo recibe ROL-003)', () => {
    const granted = new Set(ROLE_IDS.flatMap((r) => BASE_ROLE_PERMISSIONS[r]))
    for (const p of PERMISSIONS) expect(granted.has(p)).toBe(true)
    expect(BASE_ROLE_PERMISSIONS['ROL-003']).toContain('driver.manage')
  })
  it('solo ROL-001 tiene gobierno de plataforma; los admins de negocio no ejecutan viajes propios', () => {
    for (const r of ROLE_IDS.filter((x) => x !== 'ROL-001')) expect(BASE_ROLE_PERMISSIONS[r]).not.toContain('platform.tenant.manage')
    expect(BASE_ROLE_PERMISSIONS['ROL-002']).not.toContain('driver.own_trip.execute')
    expect(BASE_ROLE_PERMISSIONS['ROL-008']).toEqual(['trip.arrival.record', 'driver.own_trip.execute'])
  })
})

const principal = (over: Partial<Principal>): Principal => ({
  userId: 'u1', name: 'X', email: 'x@x', kind: 'tenant', tenantId: 't1', tenantName: 'T', roles: ['ROL-007'], permissions: ['tracking.view', 'alert.manage'],
  scopes: [{ type: 'BASE', id: 'b1', label: 'Base Norte' }], timezone: 'America/Lima', isNative: false, document: null, sessionId: 's', ...over,
})
const env = (over: Partial<RealtimeEnvelope>): RealtimeEnvelope => ({ tenantId: 't1', event: { type: 'trip.updated', tripId: 'x' }, audience: {}, correlationId: 'c', at: '', ...over })
const conn = (p: Principal) => ({ principal: p, scope: new DataScope(p) })

describe('Tiempo real scoped (ADR-007)', () => {
  it('nunca cruza tenants', () => {
    expect(shouldDeliver(conn(principal({})), env({ tenantId: 't2' }))).toBe(false)
  })
  it('respeta permiso y terminal del usuario', () => {
    expect(shouldDeliver(conn(principal({})), env({ audience: { anyPerm: ['tracking.view'], baseId: 'b1' } }))).toBe(true)
    expect(shouldDeliver(conn(principal({})), env({ audience: { anyPerm: ['tracking.view'], baseId: 'b2' } }))).toBe(false)
    expect(shouldDeliver(conn(principal({ permissions: ['alert.manage'] })), env({ audience: { anyPerm: ['tracking.view'] } }))).toBe(false)
  })
  it('el conductor solo recibe lo propio; el pasajero nada operativo', () => {
    const driver = principal({ roles: ['ROL-008'], permissions: ['driver.own_trip.execute'], scopes: [{ type: 'OWN_RECORDS', label: 'x' }] })
    expect(shouldDeliver(conn(driver), env({ audience: { driverUserId: 'u1' } }))).toBe(true)
    expect(shouldDeliver(conn(driver), env({ audience: {} }))).toBe(false)
    expect(shouldDeliver(conn(principal({ permissions: ['passenger.portal'] })), env({}))).toBe(false)
  })
})

describe('Archivos (ADR-009) y geometría (RN-005)', () => {
  it('la firma binaria debe coincidir con el tipo declarado', () => {
    expect(matchesSignature('application/pdf', Buffer.from('%PDF-1.7'))).toBe(true)
    expect(matchesSignature('application/pdf', Buffer.from('MZ\0\0'))).toBe(false)
    expect(matchesSignature('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect(matchesSignature('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
  })
  it('nombre de archivo sin rutas ni caracteres de control', () => {
    expect(safeFileName('../../etc/pass\nwd.pdf')).toBe('.._.._etc_pass_wd.pdf')
  })
  it('frescura: actual, desactualizada o no disponible (nunca una posición vieja como actual)', () => {
    const now = Date.now()
    expect(classifyFreshness(new Date(now - 30_000), now, 90).freshness).toBe('Actual')
    expect(classifyFreshness(new Date(now - 300_000), now, 90).freshness).toBe('Desactualizada')
    expect(classifyFreshness(null, now, 90)).toEqual({ freshness: 'No disponible', ageSeconds: null })
  })
  it('distancias para corredor de ruta', () => {
    expect(Math.round(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) / 1000)).toBe(111)
    expect(distanceToRouteM({ lat: 0, lon: 0.5 }, [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }])).toBeLessThan(1)
  })
})
