import { Cursor, pageInMemory, parseListQuery } from './http/list-query'
import { canonical, requestHash } from './idempotency/idempotency.service'
import { AppError, Errors } from './errors/app-error'
import { ProblemFilter, StructuralValidationError } from './filters/problem.filter'
import { Prisma } from '../generated/prisma/client'
import { TenantIsolationError } from '../database/tenant-isolation.extension'
import { loadConfig, ConfigError } from '../config/app-config'

describe('Contrato de listas (ADR-002 · FE-CONTRACT-014)', () => {
  const spec = { sortable: ['plate'], filters: ['eligibility'] }
  it('valida paginación, orden (lista blanca) y filtros declarados', () => {
    expect(parseListQuery({ page: '2', pageSize: '10', sort: '-plate', eligibility: 'Elegible', hack: 'x' }, spec)).toEqual({ page: 2, pageSize: 10, search: null, sort: { field: 'plate', dir: 'desc' }, filters: { eligibility: 'Elegible' } })
    expect(() => parseListQuery({ sort: 'passwordHash' }, spec)).toThrow(AppError)
    expect(() => parseListQuery({ pageSize: '1000' }, spec)).toThrow(AppError)
  })
  it('facetas y overall sobre el universo, sin importar filtros', () => {
    const items = [{ e: 'A' }, { e: 'A' }, { e: 'B' }]
    const q = parseListQuery({ eligibility: 'B' }, { sortable: [], filters: ['eligibility'] })
    const page = pageInMemory(items, q, { filters: { eligibility: (t, v) => t.e === v }, facets: { e: (t) => t.e } })
    expect(page).toMatchObject({ total: 1, overall: 3, facets: { e: { A: 2, B: 1 } } })
  })
  it('cursor opaco reversible y seguro ante manipulación', () => {
    const d = new Date('2026-01-01T00:00:00Z')
    expect(Cursor.decode(Cursor.encode(d, 'abc'))).toEqual({ at: d, id: 'abc' })
    expect(() => Cursor.decode('%%%')).toThrow(AppError)
  })
})

describe('Idempotencia (ADR-002)', () => {
  it('la misma intención produce el mismo hash aunque cambie el orden de claves', () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }))
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }))
  })
})

describe('Modelo de error problem+json (ADR-013)', () => {
  const f = new ProblemFilter()
  it('mapea errores de dominio con código estable, extensiones y correlationId', () => {
    const p = f.toProblem(Errors.gate({ overall: 'No habilitado' }, 'x'), 'c-1')
    expect(p).toMatchObject({ status: 422, code: 'GATE_NOT_SATISFIED', correlationId: 'c-1', extensions: { gate: { overall: 'No habilitado' } } })
  })
  it('validación estructural ⇒ 422 con errores por campo', () => {
    expect(f.toProblem(new StructuralValidationError([{ field: 'email', message: 'm' }]), 'c')).toMatchObject({ status: 422, errors: [{ field: 'email' }] })
  })
  it('duplicado en BD ⇒ 409; intento cross-tenant ⇒ 403 sin revelar; error desconocido ⇒ 500 sin detalles internos', () => {
    const dup = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' })
    expect(f.toProblem(dup, 'c')).toMatchObject({ status: 409, code: 'RESOURCE_CONFLICT' })
    expect(f.toProblem(new TenantIsolationError('x'), 'c')).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    const p = f.toProblem(new Error('SELECT * FROM secret'), 'c')
    expect(p.status).toBe(500)
    expect(JSON.stringify(p)).not.toContain('secret')
  })
})

describe('Configuración (startup checks)', () => {
  it('producción exige secretos reales y cookie segura', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x' })).toThrow(ConfigError)
    const secret = 'a'.repeat(40)
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', DATABASE_SYSTEM_URL: 'y', JWT_ACCESS_SECRET: secret, FILES_SIGNING_SECRET: secret, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/)
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', DATABASE_SYSTEM_URL: 'y', JWT_ACCESS_SECRET: secret, FILES_SIGNING_SECRET: secret }).auth.cookieSecure).toBe(true)
  })
  it('producción exige dos roles de base de datos distintos (RLS por tenant)', () => {
    const secret = 'a'.repeat(40)
    const base = { NODE_ENV: 'production', JWT_ACCESS_SECRET: secret, FILES_SIGNING_SECRET: secret }
    expect(() => loadConfig({ ...base, DATABASE_URL: 'app' })).toThrow(/DATABASE_SYSTEM_URL/)
    expect(() => loadConfig({ ...base, DATABASE_URL: 'app', DATABASE_SYSTEM_URL: 'app' })).toThrow(/rol distinto/)
    expect(loadConfig({ ...base, DATABASE_URL: 'app', DATABASE_SYSTEM_URL: 'platform' }).databaseSystemUrl).toBe('platform')
    expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'app' }).databaseSystemUrl).toBe('app')
  })
  it('umbrales operativos configurables con límites', () => {
    expect(loadConfig({ NODE_ENV: 'development', POSITION_FRESH_SECONDS: '120' }).ops.positionFreshSeconds).toBe(120)
    expect(() => loadConfig({ NODE_ENV: 'development', POSITION_FRESH_SECONDS: '0' })).toThrow(ConfigError)
  })
  it('los ajustes HTTP y del corredor de ruta se validan en un solo lugar', () => {
    const c = loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'true', AUTH_RATE_LIMIT_PER_MIN: '50', ROUTE_CORRIDOR_METERS: '800' })
    expect(c.http).toEqual({ trustProxy: true, authRateLimitPerMin: 50 })
    expect(c.ops.routeCorridorMeters).toBe(800)
    expect(() => loadConfig({ NODE_ENV: 'development', ROUTE_CORRIDOR_METERS: '5' })).toThrow(ConfigError)
    expect(() => loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'si' })).toThrow(ConfigError)
  })
  it('sin NODE_ENV se asume producción: no se aceptan secretos de relleno ni de desarrollo', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    const dev = loadConfig({ NODE_ENV: 'development' })
    expect(dev.swaggerEnabled).toBe(true)
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', DATABASE_SYSTEM_URL: 'y', JWT_ACCESS_SECRET: dev.auth.accessSecret, FILES_SIGNING_SECRET: 'a'.repeat(40) })).toThrow(/relleno/)
  })
})
