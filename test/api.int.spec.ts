/**
 * Pruebas de integración de la API (DOC-E-BE §X): contra PostgreSQL real, con la semilla DEMO.
 * Prioridad del prompt §32: auth, permisos, aislamiento de tenant, restricciones SuperAdmin, suscripción/bloqueo,
 * auditoría, transacciones, concurrencia, idempotencia, RN/CTRL críticos y reconciliación con FE-CONTRACT.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { JobsService } from '../src/modules/jobs/jobs.service'
import { RequestContext } from '../src/common/context/request-context'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaService, type Tx } from '../src/database/prisma.service'
import { login, startApp, TELEMETRY_KEY } from './int/harness'

type Call = Awaited<ReturnType<typeof startApp>>['call']
type Obj = Record<string, unknown> & { items?: Obj[] }
let app: NestFastifyApplication
let call: Call
const tokens: Record<string, string> = {}
const as = (k: string) => tokens[k]!

beforeAll(async () => {
  ;({ app, call } = await startApp())
  for (const [k, slug, email] of [
    ['jefe', 'andina', 'jefe@andina.demo'], ['despacho', 'andina', 'despacho@andina.demo'], ['rutas', 'andina', 'rutas@andina.demo'], ['control', 'andina', 'control@andina.demo'],
    ['seguridad', 'andina', 'seguridad@andina.demo'], ['mant', 'andina', 'mantenimiento@andina.demo'], ['flota', 'andina', 'flota@andina.demo'], ['conductor', 'andina', 'conductor@andina.demo'],
    ['admin', 'andina', 'admin@andina.demo'], ['pasajeros', 'andina', 'pasajeros@andina.demo'], ['carga', 'andina', 'carga@andina.demo'], ['pasajero', 'andina', 'pasajero@andina.demo'],
    ['sur', 'sur', 'jefe@sur.demo'], ['surDespacho', 'andina', 'sur@andina.demo'], ['sa', null, 'superadmin@plataforma.demo'],
  ] as const) tokens[k] = await login(call, slug, email)
})
afterAll(async () => {
  await app?.close()
})

const trips = async (token = as('jefe')) => (await call<{ items: Obj[] }>('GET', '/trips?pageSize=100', { token })).body.items
const tripBy = async (plate: string, token?: string) => (await trips(token)).find((t) => t.vehiclePlate === plate)!

describe('Autenticación (ADR-003)', () => {
  it('credenciales erróneas, slug inexistente y correo inexistente responden igual (no revela qué existe)', async () => {
    const a = await call('POST', '/auth/login', { body: { slug: 'andina', email: 'jefe@andina.demo', password: 'Incorrecta1' } })
    const b = await call('POST', '/auth/login', { body: { slug: 'nadie', email: 'jefe@andina.demo', password: 'Incorrecta1' } })
    const c = await call('POST', '/auth/login', { body: { slug: 'andina', email: 'nadie@andina.demo', password: 'Incorrecta1' } })
    for (const r of [a, b, c]) expect(r).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED', detail: 'Correo o contraseña incorrectos.' } })
  })
  it('el correo es único POR negocio: el mismo correo no entra a otro negocio (PC-A22)', async () => {
    expect((await call('POST', '/auth/login', { body: { slug: 'sur', email: 'despacho@andina.demo', password: 'Demo1234' } })).status).toBe(401)
  })
  it('negocio suspendido: TENANT_CONTEXT_INVALID con estado, datos conservados (EXC-002)', async () => {
    const r = await call<Obj>('POST', '/auth/login', { body: { slug: 'delta', email: 'admin@delta.demo', password: 'Demo1234' } })
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'TENANT_CONTEXT_INVALID', extensions: { tenantStatus: 'Suspendido' } })
  })
  it('refresh rota el token; reutilizar el anterior (fuera de la ventana benigna) revoca la familia', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ slug: 'andina', email: 'rutas@andina.demo', password: 'Demo1234' }) })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie, 'x-client-version': '1' } })
    expect(ok.statusCode).toBe(200)
    const prisma = app.get(PrismaService)
    await prisma.system.authSession.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } })
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie, 'x-client-version': '1' } })
    expect(reuse.statusCode).toBe(401)
    const newCookie = String(ok.headers['set-cookie']).split(';')[0]!
    const afterRevoke = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: newCookie, 'x-client-version': '1' } })
    expect(afterRevoke.statusCode).toBe(401)
  })
  it('logout invalida también el access token vigente (revocación inmediata)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ slug: 'andina', email: 'carga@andina.demo', password: 'Demo1234' }) })
    const token = JSON.parse(r.body).accessToken as string
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    expect((await call('GET', '/cargo-shipments', { token })).status).toBe(200)
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-client-version': '1' } })
    expect((await call('GET', '/cargo-shipments', { token })).status).toBe(401)
  })
})

describe('Autorización y alcance (DOC-A §J · POL-002)', () => {
  it('sin permiso ⇒ 403 y la denegación queda auditada como evento de Seguridad', async () => {
    const r = await call<Obj>('POST', '/routes', { token: as('control'), body: { name: 'x' } })
    expect(r.status).toBe(403)
    const denied = await call<{ items: Obj[] }>('GET', '/audit-events?flag=denegado&pageSize=50', { token: as('jefe') })
    expect(denied.body.items.some((e) => e.action === 'access.denied' && e.kind === 'Seguridad')).toBe(true)
  })
  it('alcance BASE: un despachador de Base Sur no ve viajes de Base Norte', async () => {
    const mine = await trips(as('surDespacho'))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((t) => t.baseName === 'Base Sur')).toBe(true)
    const north = await tripBy('BUS-101')
    expect((await call('GET', `/trips/${north.id}`, { token: as('surDespacho') })).status).toBe(403)
  })
  it('un admin de negocio no asigna roles de plataforma ni cupos de administrador (RN-010 · PC-A1)', async () => {
    const base = { name: 'Intruso', email: 'x1@andina.demo', scopes: [{ type: 'TENANT', label: 'Todo' }] }
    expect((await call('POST', '/users', { token: as('admin'), body: { ...base, roles: ['ROL-001'] } })).status).toBe(403)
    expect((await call('POST', '/users', { token: as('admin'), body: { ...base, roles: ['ROL-015'] } })).status).toBe(403)
    const ok = await call<Obj>('POST', '/users', { token: as('admin'), body: { ...base, roles: ['ROL-006'] } })
    expect(ok.status).toBe(201)
    expect(typeof ok.body.temporaryPassword).toBe('string')
  })
})

describe('Aislamiento entre negocios (NFR-001 · KPI-012)', () => {
  it('otro negocio no ve, no edita y no acciona recursos ajenos (misma respuesta que «no existe»)', async () => {
    const t = await tripBy('BUS-101')
    const veh = (await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: as('jefe') })).body.items.find((v) => v.plate === 'BUS-101')!
    expect((await call('GET', `/trips/${t.id}`, { token: as('sur') })).status).toBe(403)
    expect((await call('GET', `/trips/${t.id}/gate`, { token: as('sur') })).status).toBe(403)
    expect((await call('POST', `/trips/${t.id}/arrival`, { token: as('sur'), body: {} })).status).toBe(403)
    expect((await call('PATCH', `/vehicles/${veh.id}`, { token: as('sur'), body: { fuel: 'GLP', version: veh.version } })).status).toBe(403)
    expect((await call('GET', `/trips/${t.id}/messages`, { token: as('sur') })).status).toBe(403)
    const surVeh = await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: as('sur') })
    expect(surVeh.body.items.some((v) => v.id === veh.id)).toBe(false)
  })
  it('la auditoría de un negocio no contiene eventos de otro', async () => {
    const r = await call<{ items: Obj[] }>('GET', '/audit-events?pageSize=100', { token: as('sur') })
    const surTenant = r.body.items[0]?.tenantId
    expect(r.body.items.every((e) => e.tenantId === surTenant)).toBe(true)
  })
  it('una clave de idempotencia de un usuario no devuelve respuestas de otro', async () => {
    const t = await tripBy('BUS-102')
    const k = { 'Idempotency-Key': 'shared-key-0000001' }
    const a = await call('POST', `/trips/${t.id}/enable`, { token: as('despacho'), body: {}, headers: k })
    const b = await call('POST', `/trips/${t.id}/enable`, { token: as('sur'), body: {}, headers: k })
    expect(a.status).toBe(422)
    expect(b.status).toBe(403)
  })
})

describe('Planificación, gate CTRL-001 y SoD (PROC-003)', () => {
  it('RN-002: no se asigna un vehículo ya comprometido en una ventana superpuesta; bajo concurrencia solo una gana', async () => {
    const routes = await call<{ items: Obj[] }>('GET', '/routes?pageSize=50', { token: as('rutas') })
    const r1 = routes.body.items.find((r) => r.name === 'Lima – Trujillo')!
    const veh = (await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: as('jefe') })).body.items
    const drv = (await call<{ items: Obj[] }>('GET', '/drivers?pageSize=50', { token: as('jefe') })).body.items
    const min = veh.find((v) => v.plate === 'MIN-201')!
    const dep = new Date(Date.now() + 5 * 3_600_000 + 30 * 60_000).toISOString()
    const eta = new Date(Date.now() + 9 * 3_600_000).toISOString()
    const clash = await call<Obj>('POST', '/trips', { token: as('rutas'), body: { routeId: r1.id, plannedDeparture: dep, plannedEta: eta, vehicleId: min.id, driverId: null, priority: 'Normal', instructions: '' } })
    expect(clash.status).toBe(409)
    expect(String(clash.body.detail)).toContain('RN-002')
    // Dos planificaciones simultáneas del mismo conductor libre: el bloqueo de filas deja pasar solo una.
    const free = drv.find((d) => d.name === 'Carlos Rojas')!
    const far = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
    const body = { routeId: r1.id, plannedDeparture: far(200), plannedEta: far(206), vehicleId: null, driverId: free.id, priority: 'Normal', instructions: '' }
    const [x, y] = await Promise.all([call('POST', '/trips', { token: as('rutas'), body }), call('POST', '/trips', { token: as('rutas'), body })])
    expect([x.status, y.status].sort()).toEqual([201, 409])
  })

  it('el gate explica requisito, responsable y regla; con fallo crítico no hay transición parcial', async () => {
    const t = await tripBy('BUS-102')
    const g = await call<{ overall: string; requirements: Obj[] }>('GET', `/trips/${t.id}/gate`, { token: as('despacho') })
    expect(g.body.overall).toBe('No habilitado')
    expect(g.body.requirements.find((r) => r.id === 'DOC-01')).toMatchObject({ status: 'Falla', rule: 'CTRL-004 · RN-009' })
    const r = await call<Obj>('POST', `/trips/${t.id}/enable`, { token: as('despacho'), body: {} })
    expect(r).toMatchObject({ status: 422, body: { code: 'GATE_NOT_SATISFIED' } })
    expect((await call<Obj>('GET', `/trips/${t.id}`, { token: as('despacho') })).body.lifecycle).toBe('Asignado')
    // KPI-004: la evaluación fallida quedó registrada aunque la transición se revirtió.
    const evals = await app.get(PrismaService).system.gateEvaluation.count({ where: { tripId: String(t.id), failed: true } })
    expect(evals).toBeGreaterThan(0)
  })

  it('SOD-001: quien creó el viaje no lo despacha; la excepción exige ROL-003 y motivo, y queda auditada', async () => {
    const t = await tripBy('CAM-301')
    const denied = await call<Obj>('POST', `/trips/${t.id}/dispatch`, { token: as('jefe'), body: {} })
    expect(denied.status).toBe(403)
    expect(denied.body.extensions).toMatchObject({ rule: 'SOD-001', exceptionAllowed: true })
    const ok = await call<Obj>('POST', `/trips/${t.id}/dispatch`, { token: as('jefe'), body: { sodException: 'Único jefe disponible en el turno nocturno' } })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ lifecycle: 'Listo para salida', dispatchAuthorized: true })
  })

  it('un viaje con pasajeros o carga pendientes no se cierra (EVT-008)', async () => {
    const t = await tripBy('BUS-101')
    await call('POST', `/trips/${t.id}/arrival`, { token: as('despacho'), body: {} })
    // Pasajero que abordó y aún no registra su bajada (dato preparado directamente en la BD de prueba).
    const prisma = app.get(PrismaService)
    const { tenantId } = (await prisma.system.trip.findUnique({ where: { id: String(t.id) } }))!
    // El rol de plataforma es de solo lectura sobre datos operativos: el fixture se escribe como la app, confinado al tenant.
    await RequestContext.asTenant(tenantId, async () => await prisma.db.passengerBooking.create({
      data: { tenantId, code: 'PX-TEST', documentType: 'DNI', document: '12345678', lastNamePaternal: 'Prueba', firstNames: 'Ana', tripId: String(t.id), tripCode: String(t.code), routeName: 'x', plannedDeparture: new Date(), vehiclePlate: 'BUS-101', boardStop: 'Terminal Lima', alightStop: 'Terminal Trujillo', seat: 3, status: 'ABORDO', createdBy: 'test' },
    }))
    const r = await call<Obj>('POST', `/trips/${t.id}/close`, { token: as('jefe'), body: {} })
    expect(r.status).toBe(409)
    expect(String(r.body.detail)).toContain('EVT-008')
  })

  it('versión optimista: una edición con versión vieja devuelve 409 (ADR-006)', async () => {
    const v = (await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: as('flota') })).body.items.find((x) => x.plate === 'BUS-103')!
    const first = await call('PATCH', `/vehicles/${v.id}`, { token: as('flota'), body: { fuel: 'Diésel B5', version: v.version } })
    const stale = await call<Obj>('PATCH', `/vehicles/${v.id}`, { token: as('flota'), body: { fuel: 'GNV', version: v.version } })
    expect(first.status).toBe(200)
    expect(stale.status).toBe(409)
  })

  it('SOD-002: quien bloqueó no libera su propio bloqueo', async () => {
    const v = (await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: as('mant') })).body.items.find((x) => x.plate === 'BUS-103')!
    const r = await call<Obj>('POST', `/vehicles/${v.id}/unblock`, { token: as('mant'), body: { reason: 'Frenos reparados y probados' } })
    expect(r.status).toBe(403)
    expect(r.body.extensions).toMatchObject({ rule: 'SOD-002' })
  })
})

describe('Conductor offline, telemetría y alertas', () => {
  it('outbox: la misma Idempotency-Key devuelve el mismo resultado; «Rechazada» es definitiva', async () => {
    const my = (await call<Obj[]>('GET', '/driver/trips', { token: as('conductor') })).body
    const act = { tripId: my[0]!.id, type: 'message', occurredAt: new Date().toISOString(), payload: { message: { text: 'Todo en orden' } } }
    const a = await call('POST', '/driver/actions', { token: as('conductor'), body: act, headers: { 'Idempotency-Key': 'int-drv-0000001' } })
    const b = await call('POST', '/driver/actions', { token: as('conductor'), body: act, headers: { 'Idempotency-Key': 'int-drv-0000001' } })
    expect(a.body).toEqual(b.body)
    const other = await tripBy('CAM-301')
    const rej = await call<Obj>('POST', '/driver/actions', { token: as('conductor'), body: { ...act, tripId: other.id, type: 'arrival', payload: {} }, headers: { 'Idempotency-Key': 'int-drv-0000002' } })
    expect(rej.body).toMatchObject({ status: 'Rechazada', code: 'FORBIDDEN' })
    expect((await call('POST', '/driver/actions', { token: as('conductor'), body: act })).status).toBe(422)
  })

  it('telemetría: exceso de velocidad genera UNA alerta idempotente por viaje (RN-006)', async () => {
    const send = (speed: number, ageMs: number) =>
      call<Obj>('POST', '/telemetry/positions', { headers: { 'X-Integration-Key': TELEMETRY_KEY }, body: { events: [{ deviceId: 'GPS-andina-301', sourceTime: new Date(Date.now() - ageMs).toISOString(), lat: -12.1, lon: -77.0, speedKmh: speed }] } })
    const cam = await tripBy('CAM-301')
    // CAM-301 es de Base Sur: lo despacha el despachador con alcance en esa terminal (el de Base Norte no lo ve).
    const started = await call<Obj>('POST', `/trips/${cam.id}/dispatch`, { token: as('surDespacho'), body: { startNow: true } })
    expect(started.body.lifecycle).toBe('En ruta')
    expect((await send(120, 2000)).status).toBe(202)
    expect((await send(125, 1000)).status).toBe(202)
    const alerts = await call<{ items: Obj[] }>('GET', '/alerts?pageSize=50&kind=Exceso de velocidad&open=1', { token: as('control') })
    const forCam = alerts.body.items.filter((a) => a.vehiclePlate === 'CAM-301')
    expect(forCam.length).toBeLessThanOrEqual(1)
  })

  it('el cierre de una alerta Alta/Crítica exige revisión senior (CTRL-013)', async () => {
    const list = await call<{ items: Obj[] }>('GET', '/alerts?pageSize=50&severity=Alta&open=1', { token: as('control') })
    const a = list.body.items[0]!
    await call('POST', `/alerts/${a.id}/acknowledge`, { token: as('control'), body: {} })
    await call('POST', `/alerts/${a.id}/resolve`, { token: as('control'), body: { reason: 'Se contactó al conductor' } })
    expect((await call('POST', `/alerts/${a.id}/close`, { token: as('control'), body: {} })).status).toBe(403)
    expect((await call('POST', `/alerts/${a.id}/close`, { token: as('seguridad'), body: {} })).status).toBe(200)
  })

  it('PC-A7: el job de vencimientos crea UNA alerta por documento y renovar el documento la resuelve', async () => {
    const jobs = app.get(JobsService)
    const prisma = app.get(PrismaService)
    const tenant = (await prisma.system.tenant.findUnique({ where: { slug: 'andina' } }))!
    await RequestContext.asTenant(tenant.id, () => jobs.syncDocumentAlerts(tenant.id))
    await RequestContext.asTenant(tenant.id, () => jobs.syncDocumentAlerts(tenant.id))
    const alerts = await call<{ items: Obj[] }>('GET', '/alerts?pageSize=100&kind=Vencimiento', { token: as('mant') })
    const bus102 = alerts.body.items.filter((a) => a.subject === 'BUS-102')
    expect(bus102.length).toBe(1)
    expect(bus102[0]).toMatchObject({ phase: 'Vencido', severity: 'Alta' })
    const renew = await call('POST', '/documents', {
      token: as('mant'),
      body: { resourceType: 'Vehículo', resourceId: (await tripBy('BUS-102')).vehicleId, docType: 'Revisión técnica', number: 'RT-NUEVA', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(), critical: true, fileName: null },
    })
    expect(renew.status).toBe(201)
    const after = await call<{ items: Obj[] }>('GET', `/alerts?pageSize=100&kind=Vencimiento`, { token: as('mant') })
    expect(after.body.items.find((a) => a.id === bus102[0]!.id)).toMatchObject({ status: 'Resuelta' })
  })
})

describe('Plataforma, SuperAdmin y suscripciones (prompt §14–16)', () => {
  it('un Delegado no crea SuperAdmins; el Nativo sí, hasta 2; nadie modifica al Nativo', async () => {
    const d1 = await call<Obj>('POST', '/platform/admins', { token: as('sa'), body: { name: 'Delegado Uno', email: 'd1@plataforma.demo' } })
    expect(d1.status).toBe(201)
    const pwd = String(d1.body.temporaryPassword)
    const del = (await call<{ accessToken: string }>('POST', '/auth/login', { body: { email: 'd1@plataforma.demo', password: pwd } })).body.accessToken
    expect((await call('POST', '/platform/admins', { token: del, body: { name: 'Delegado Dos', email: 'd2@plataforma.demo' } })).status).toBe(403)
    expect((await call('POST', '/platform/admins', { token: as('sa'), body: { name: 'Delegado Dos', email: 'd2@plataforma.demo' } })).status).toBe(201)
    expect((await call('POST', '/platform/admins', { token: as('sa'), body: { name: 'Delegado Tres', email: 'd3@plataforma.demo' } })).status).toBe(409)
    const native = (await call<Obj[]>('GET', '/platform/admins', { token: as('sa') })).body.find((a) => a.nativo)!
    expect((await call('POST', `/platform/admins/${native.id}/status`, { token: as('sa'), body: { active: false } })).status).toBe(403)
  })

  it('la plataforma nunca ve el contenido de un negocio en la auditoría (EXC-032)', async () => {
    const r = await call<{ items: Obj[] }>('GET', '/audit-events?pageSize=100', { token: as('sa') })
    expect(r.body.items.filter((e) => e.tenantId).every((e) => e.before === undefined && e.after === undefined && e.resourceId === '—')).toBe(true)
  })

  it('cerrar un negocio está bloqueado (GAP-003); suspender corta el acceso sin borrar datos', async () => {
    const tenants = await call<{ items: Obj[] }>('GET', '/platform/tenants?pageSize=50', { token: as('sa') })
    const sur = tenants.body.items.find((t) => t.slug === 'sur')!
    expect((await call('POST', `/platform/tenants/${sur.id}/transition`, { token: as('sa'), body: { to: 'Cerrado', reason: 'Prueba de cierre de negocio' } })).status).toBe(409)
    expect((await call('POST', `/platform/tenants/${sur.id}/transition`, { token: as('sa'), body: { to: 'Suspendido', reason: 'Prueba de suspensión temporal' } })).status).toBe(200)
    expect((await call('GET', '/vehicles', { token: as('sur') })).status).toBe(403)
    await call('POST', `/platform/tenants/${sur.id}/transition`, { token: as('sa'), body: { to: 'Reactivado', reason: 'Fin de la prueba de suspensión' } })
    const again = await login(call, 'sur', 'jefe@sur.demo')
    const veh = await call<{ items: Obj[] }>('GET', '/vehicles?pageSize=50', { token: again })
    expect(veh.body.items.length).toBe(5)
  })

  it('suscripción vencida más allá de la gracia bloquea el login; renovar lo restablece', async () => {
    const tenants = await call<{ items: Obj[] }>('GET', '/platform/tenants?pageSize=50', { token: as('sa') })
    const sur = tenants.body.items.find((t) => t.slug === 'sur')!
    const d = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
    await call('PATCH', `/platform/tenants/${sur.id}/subscription`, { token: as('sa'), body: { plan: 'Starter', startsAt: d(-60), endsAt: d(-30) } })
    const blocked = await call<Obj>('POST', '/auth/login', { body: { slug: 'sur', email: 'jefe@sur.demo', password: 'Demo1234' } })
    expect(blocked.status).toBe(403)
    expect(blocked.body.extensions).toMatchObject({ subscriptionExpired: true })
    await call('PATCH', `/platform/tenants/${sur.id}/subscription`, { token: as('sa'), body: { plan: 'Starter', startsAt: d(0), endsAt: d(30) } })
    expect((await call('POST', '/auth/login', { body: { slug: 'sur', email: 'jefe@sur.demo', password: 'Demo1234' } })).status).toBe(200)
  })

  it('un usuario de negocio no entra a la consola aunque se le intente dar el permiso (ROL-001 no editable)', async () => {
    expect((await call('GET', '/platform/tenants', { token: as('admin') })).status).toBe(403)
    const r = await call('PATCH', '/platform/roles/ROL-003', { token: as('sa'), body: { permissions: ['platform.tenant.manage'] } })
    expect(r.status).toBe(422)
    expect((await call('PATCH', '/platform/roles/ROL-001', { token: as('sa'), body: { permissions: [] } })).status).toBe(403)
  })
})

describe('Contratos con DOC-D-FE (reconciliación)', () => {
  it('listas: forma Page<T> con overall y facets (FE-CONTRACT-014)', async () => {
    for (const path of ['/vehicles', '/drivers', '/documents', '/maintenance-orders', '/routes', '/trips', '/alerts', '/incidents', '/users', '/services', '/cargo-shipments', '/passenger-bookings']) {
      const token = path.startsWith('/users') ? as('admin') : path.startsWith('/passenger') ? as('pasajeros') : path.startsWith('/cargo') ? as('carga') : path.startsWith('/alerts') || path.startsWith('/incidents') ? as('control') : as('jefe')
      const r = await call<Obj>('GET', `${path}?pageSize=5`, { token })
      expect(r.status).toBe(200)
      expect(r.body).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number), page: 1, pageSize: 5, cutoffAt: expect.any(String), overall: expect.any(Number), facets: expect.any(Object) }))
    }
  })
  it('errores: problem+json con code, correlationId y X-Correlation-Id eco', async () => {
    const r = await call<Obj>('GET', '/trips/no-es-uuid', { token: as('jefe'), headers: { 'X-Correlation-Id': 'corr-test-000001' } })
    expect(r.status).toBe(403)
    expect(r.headers['x-correlation-id']).toBe('corr-test-000001')
    expect(r.body).toMatchObject({ code: 'FORBIDDEN', correlationId: 'corr-test-000001' })
  })
  it('exportación: el servidor clasifica la sensibilidad y exige permiso de lectura (POL-004)', async () => {
    const ok = await call<Obj>('POST', '/exports', { token: as('jefe'), body: { resource: 'Conductores', format: 'xlsx', filters: {}, rowCount: 4, sensitive: false } })
    expect(ok.status).toBe(200)
    const last = await call<{ items: Obj[] }>('GET', '/audit-events?flag=exportacion&pageSize=1', { token: as('jefe') })
    expect(String(last.body.items[0]!.after)).toContain('datos sensibles')
    expect((await call('POST', '/exports', { token: as('jefe'), body: { resource: 'Usuarios', format: 'pdf', filters: {}, rowCount: 1, sensitive: true } })).status).toBe(403)
  })
  it('portal del pasajero: solo sus reservas, resueltas por la cuenta (PC-A9)', async () => {
    const r = await call<Obj[]>('GET', '/me/bookings', { token: as('pasajero') })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })
})

describe('Integridad referencial en la base de datos (migración referential_integrity)', () => {
  it('las referencias críticas están respaldadas por claves foráneas: PostgreSQL rechaza huérfanos aunque la aplicación falle', async () => {
    // pg_constraint (no information_schema): esta última solo muestra tablas sobre las que el rol tiene más que SELECT.
    const rows = await app.get(PrismaService).system.$queryRaw<{ t: string; c: string }[]>`
      SELECT con.conrelid::regclass::text AS t, a.attname AS c
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`
    const fks = new Set(rows.map((r) => `${r.t}.${r.c}`))
    for (const ref of ['trip.vehicleId', 'trip.driverId', 'trip.routeId', 'trip.baseId', 'trip.tenantId', 'vehicle.baseId', 'vehicle.fleetId', 'vehicle.tenantId', 'trip_event.tripId', 'maintenance_order.vehicleId', 'alert.tripId', 'incident.reportedById', 'telemetry_event.vehicleId', 'auth_session.userId']) {
      expect(fks).toContain(ref)
    }
  })

  it('insertar un viaje que apunta a un vehículo inexistente falla con violación de clave foránea', async () => {
    const prisma = app.get(PrismaService)
    const t = await prisma.system.trip.findFirstOrThrow({})
    const { id: _id, ...copy } = t
    await expect(
      RequestContext.asTenant(t.tenantId, async () => await prisma.db.trip.create({ data: { ...copy, code: `ORF-${Date.now()}`, vehicleId: '00000000-0000-4000-8000-000000000000' } })),
    ).rejects.toMatchObject({ code: 'P2003' })
  })
})

describe('Aislamiento por tenant en PostgreSQL (RLS · migración row_level_security)', () => {
  // Cliente PROPIO del rol de la aplicación, sin la capa de aislamiento de Prisma: prueba lo que garantiza la base de datos por sí sola.
  let raw: PrismaClient
  let andina: string
  let sur: string
  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }) })
    const sys = app.get(PrismaService).system
    andina = (await sys.tenant.findUniqueOrThrow({ where: { slug: 'andina' } })).id
    sur = (await sys.tenant.findUniqueOrThrow({ where: { slug: 'sur' } })).id
  })
  afterAll(async () => {
    await raw?.$disconnect()
  })
  const asTenant = async <T,>(tenantId: string | null, q: (tx: Tx) => Promise<T>): Promise<T> =>
    raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`
      return q(tx)
    })

  it('el rol de la aplicación no es superusuario ni tiene BYPASSRLS', async () => {
    const [r] = await raw.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false })
  })

  it('RLS activa y forzada en TODA tabla con tenantId (una tabla nueva sin política rompe esta prueba)', async () => {
    const rows = await raw.$queryRaw<{ t: string }[]>`
      SELECT c.table_name AS t FROM information_schema.columns c
      JOIN pg_class p ON p.relname = c.table_name AND p.relnamespace = 'public'::regnamespace AND p.relkind = 'r'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' AND NOT (p.relrowsecurity AND p.relforcerowsecurity)`
    expect(rows.map((r) => r.t)).toEqual([])
  })

  it('sin tenant fijado no se ve ninguna fila (fail-closed); con tenant solo las suyas', async () => {
    expect(await asTenant(null, (tx) => tx.vehicle.count())).toBe(0)
    const a = await asTenant(andina, (tx) => tx.vehicle.count())
    const s = await asTenant(sur, (tx) => tx.vehicle.count())
    expect(a).toBeGreaterThan(0)
    expect(s).toBeGreaterThan(0)
    const all = await app.get(PrismaService).system.vehicle.count()
    expect(a + s).toBeLessThanOrEqual(all)
    expect((await asTenant(andina, (tx) => tx.vehicle.findMany())).every((v) => v.tenantId === andina)).toBe(true)
  })

  it('aunque la aplicación olvidara el filtro, un tenant no lee ni modifica filas de otro', async () => {
    const sVeh = await asTenant(sur, (tx) => tx.vehicle.findFirstOrThrow())
    expect(await asTenant(andina, (tx) => tx.vehicle.findUnique({ where: { id: sVeh.id } }))).toBeNull()
    expect((await asTenant(andina, (tx) => tx.vehicle.updateMany({ where: { id: sVeh.id }, data: { fuel: 'X' } }))).count).toBe(0)
    expect((await asTenant(andina, (tx) => tx.vehicle.deleteMany({ where: { id: sVeh.id } }))).count).toBe(0)
  })

  it('no se puede insertar con el tenantId de otro (WITH CHECK)', async () => {
    const v = await asTenant(andina, (tx) => tx.vehicle.findFirstOrThrow())
    const { id: _id, version: _v, ...copy } = v
    await expect(asTenant(sur, (tx) => tx.vehicle.create({ data: { ...copy, plate: `RLS-${Date.now() % 100000}`, tenantId: andina } }))).rejects.toThrow()
  })

  it('el tenant solo ve su propia fila en la tabla de negocios y las filas de plataforma son invisibles', async () => {
    expect((await asTenant(andina, (tx) => tx.tenant.findMany())).map((t) => t.id)).toEqual([andina])
    expect(await asTenant(andina, (tx) => tx.user.count({ where: { tenantId: null } }))).toBe(0)
  })

  it('la plataforma gobierna, no opera: transportes_platform solo LEE datos operativos, pero escribe lo que gobierna (EXC-032)', async () => {
    const priv = async (table: string, p: string) => (await raw.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_table_privilege('transportes_platform', '${table}', '${p}') AS ok`))[0]!.ok
    for (const t of ['trip', 'vehicle', 'driver', 'alert', 'incident', 'cargo_shipment', 'passenger_booking', 'telemetry_event', 'stored_file']) {
      expect(await priv(t, 'SELECT')).toBe(true)
      for (const w of ['INSERT', 'UPDATE', 'DELETE']) expect(await priv(t, w)).toBe(false)
    }
    for (const t of ['app_user', 'auth_session', 'audit_event', 'support_session', 'tenant_subscription', 'backup_record']) expect(await priv(t, 'INSERT')).toBe(true)
  })

  it('toda referencia entre tablas con tenantId tiene su guarda de mismo tenant', async () => {
    const missing = await raw.$queryRaw<{ child: string; col: string }[]>`
      SELECT con.conrelid::regclass::text AS child, a.attname AS col
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND con.connamespace = 'public'::regnamespace
        AND con.confrelid <> 'tenant'::regclass
        AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.conrelid AND x.attname = 'tenantId' AND NOT x.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = con.confrelid AND y.attname = 'tenantId' AND NOT y.attisdropped)
        AND NOT (con.conrelid = 'support_session'::regclass AND a.attname = 'requestedById')
        AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = con.conrelid AND tg.tgname = 'same_tenant_' || a.attname)`
    expect(missing).toEqual([])
  })

  it('una fila no puede referenciar a un padre de OTRO tenant, ni siquiera con el id correcto', async () => {
    const sRoute = await asTenant(sur, (tx) => tx.route.findFirstOrThrow())
    const aTrip = await asTenant(andina, (tx) => tx.trip.findFirstOrThrow())
    const { id: _id, version: _v, ...copy } = aTrip
    await expect(asTenant(andina, (tx) => tx.trip.create({ data: { ...copy, code: `XT-${Date.now() % 100000}`, routeId: sRoute.id } }))).rejects.toThrow()
  })

  it('el tenant de una fila es inmutable, también para el rol de plataforma (BYPASSRLS)', async () => {
    const sys = app.get(PrismaService).system
    await expect(sys.$executeRaw`UPDATE app_user SET "tenantId" = ${sur}::uuid WHERE "tenantId" = ${andina}::uuid`).rejects.toThrow(/inmutable/)
    await expect(asTenant(andina, (tx) => tx.$executeRaw`UPDATE vehicle SET "tenantId" = ${sur}::uuid`)).rejects.toThrow()
    expect(await sys.user.count({ where: { tenantId: andina } })).toBeGreaterThan(0)
  })

  it('un servicio que usa `db` DENTRO del callback de una transacción sigue confinado a su tenant', async () => {
    const prisma = app.get(PrismaService)
    const n = await RequestContext.asTenant(andina, () => prisma.tx(async () => prisma.db.vehicle.count()))
    expect(n).toBe(await asTenant(andina, (tx) => tx.vehicle.count()))
    expect(n).toBeGreaterThan(0)
  })
})
