/**
 * DOC-E-BE §V — Semilla DEMO. Deriva de los roles REALES de DOC-A (no ADMIN/SUPERVISOR/OPERADOR genéricos) y cubre estados y
 * excepciones relevantes: recursos elegibles / condicionados / no habilitados, documentos por vencer y vencidos, viajes en todo
 * el lifecycle, alertas e incidencias abiertas, un negocio SUSPENDIDO (EXC-002) y dos negocios para probar el aislamiento.
 *
 * NUNCA en producción: se niega a correr con NODE_ENV=production. Contraseña DEMO: SEED_DEMO_PASSWORD (por defecto «Demo1234»).
 * Ejecutar: npm run db:seed (sobre una BD recién migrada). Es idempotente por slug: si el negocio demo existe, no lo duplica.
 */
import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import * as bcrypt from 'bcrypt'
import { PrismaClient, type Prisma } from '../src/generated/prisma/client'

if (process.env.NODE_ENV === 'production') {
  console.error('La semilla DEMO no se ejecuta en producción.')
  process.exit(1)
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/transportes' }) })
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo1234'
const DAY = 86_400_000
const now = Date.now()
const at = (days: number, hours = 0) => new Date(now + days * DAY + hours * 3_600_000)

type Tx = Prisma.TransactionClient

async function counter(tx: Tx, tenantId: string, name: string, start: number) {
  const r = await tx.$queryRaw<{ value: number }[]>`INSERT INTO "tenant_counter" ("tenantId","name","value") VALUES (${tenantId}::uuid, ${name}, ${start + 1}) ON CONFLICT ("tenantId","name") DO UPDATE SET "value" = "tenant_counter"."value" + 1 RETURNING "value"`
  return r[0]!.value
}

async function user(tx: Tx, hash: string, tenantId: string | null, name: string, email: string, roles: string[], scopes: { type: string; refId?: string; label: string }[], extra: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  return tx.user.create({
    data: {
      tenantId, name, email, emailKey: email.toLowerCase(), passwordHash: hash, ...extra,
      roles: { create: roles.map((roleId) => ({ roleId, tenantId })) },
      scopes: { create: scopes.map((s) => ({ tenantId, type: s.type, refId: s.refId ?? null, label: s.label })) },
    },
  })
}

const CATALOG = [
  ['CARGO_TYPE', 'General', 'Mercadería seca sin condiciones especiales.'], ['CARGO_TYPE', 'Refrigerada', 'Requiere cadena de frío.'],
  ['CARGO_TYPE', 'Peligrosa', 'Materiales peligrosos.'], ['CARGO_TYPE', 'Frágil', 'Manipulación cuidadosa.'], ['CARGO_TYPE', 'Granel', 'Carga suelta.'],
  ['SERVICE_TYPE', 'Interprovincial', 'Pasajeros entre ciudades.'], ['SERVICE_TYPE', 'Transporte de personal', 'Personal de una empresa cliente.'],
  ['SERVICE_TYPE', 'Carga dedicada', 'Flota asignada a un cliente.'], ['SERVICE_TYPE', 'Turismo', 'Excursiones y traslados.'], ['SERVICE_TYPE', 'Otro', 'Otro tipo.'],
] as const

async function tenantDemo(tx: Tx, hash: string, o: { slug: string; name: string; lifecycle: 'ACTIVO' | 'SUSPENDIDO'; plan: 'BUSINESS' | 'ENTERPRISE' | 'STARTER'; subEndsInDays: number; full: boolean; reason?: string }) {
  const t = await tx.tenant.create({
    data: {
      slug: o.slug, name: o.name, lifecycle: o.lifecycle, timezone: 'America/Lima', adminContact: `admin@${o.slug}.demo`, lastChangeReason: o.reason ?? null,
      subscriptions: { create: { plan: o.plan, startsAt: at(-30), endsAt: at(o.subEndsInDays), createdBy: 'Semilla DEMO', reason: 'Alta demo' } },
      deployment: { create: { mode: o.plan === 'ENTERPRISE' ? 'PRIVATE' : 'SAAS', version: 'Cloud', capacityContract: 'Según plan comercial', technicalContact: `ti@${o.slug}.demo`, supportChannel: 'Soporte estándar', lastUpdatedAt: new Date() } },
    },
  })
  await tx.catalogItem.createMany({ data: CATALOG.map(([kind, label, hint]) => ({ tenantId: t.id, kind, label, labelKey: label.toLowerCase(), hint, createdBy: 'Sistema' })) })
  const tenantScope = [{ type: 'TENANT', refId: t.id, label: t.name }]
  await user(tx, hash, t.id, `Owner ${o.name}`, `owner@${o.slug}.demo`, ['ROL-015'], tenantScope)
  await user(tx, hash, t.id, `Admin ${o.name}`, `admin@${o.slug}.demo`, ['ROL-002'], tenantScope)
  if (!o.full) return t

  const org = await tx.orgUnit.create({ data: { tenantId: t.id, type: 'ORGANIZACION', name: o.name } })
  const north = await tx.orgUnit.create({ data: { tenantId: t.id, type: 'BASE', name: 'Base Norte', parentId: org.id, city: 'Bahía Andina', address: 'Av. Costanera 120' } })
  const south = await tx.orgUnit.create({ data: { tenantId: t.id, type: 'BASE', name: 'Base Sur', parentId: org.id, city: 'Bahía Andina', address: 'Ruta 5 km 12' } })
  const buses = await tx.orgUnit.create({ data: { tenantId: t.id, type: 'FLOTA', name: 'Flota Pasajeros', parentId: org.id } })
  const trucks = await tx.orgUnit.create({ data: { tenantId: t.id, type: 'FLOTA', name: 'Flota Carga', parentId: org.id } })
  const N = { type: 'BASE', refId: north.id, label: 'Base Norte' }

  // Roles reales de DOC-A §B.2 con su alcance normal.
  const jefe = await user(tx, hash, t.id, 'Julia Paredes', `jefe@${o.slug}.demo`, ['ROL-003'], tenantScope)
  await user(tx, hash, t.id, 'Mario Salas', `flota@${o.slug}.demo`, ['ROL-004'], [N, { type: 'FLEET', refId: buses.id, label: 'Flota Pasajeros' }])
  const programador = await user(tx, hash, t.id, 'Rosa Quispe', `rutas@${o.slug}.demo`, ['ROL-005'], [N])
  await user(tx, hash, t.id, 'Diego Farfán', `despacho@${o.slug}.demo`, ['ROL-006'], [N])
  await user(tx, hash, t.id, 'Lucía Ramos', `control@${o.slug}.demo`, ['ROL-007'], [N])
  const mant = await user(tx, hash, t.id, 'Hugo Torres', `mantenimiento@${o.slug}.demo`, ['ROL-009'], tenantScope)
  await user(tx, hash, t.id, 'Carmen Vidal', `seguridad@${o.slug}.demo`, ['ROL-010'], tenantScope)
  await user(tx, hash, t.id, 'Pedro Luna', `carga@${o.slug}.demo`, ['ROL-011'], tenantScope)
  await user(tx, hash, t.id, 'Ana Soto', `pasajeros@${o.slug}.demo`, ['ROL-012'], tenantScope)
  await user(tx, hash, t.id, 'Pasajera Demo', `pasajero@${o.slug}.demo`, ['ROL-014'], [{ type: 'OWN_RECORDS', label: 'Registros propios' }], { document: '45879632' })
  await user(tx, hash, t.id, 'Supervisor Sur', `sur@${o.slug}.demo`, ['ROL-006'], [{ type: 'BASE', refId: south.id, label: 'Base Sur' }])

  // Conductores (uno con cuenta para la app, uno con licencia vencida → No habilitado).
  const c1u = await user(tx, hash, t.id, 'Carlos Rojas', `conductor@${o.slug}.demo`, ['ROL-008'], [{ type: 'OWN_RECORDS', label: 'Registros propios' }])
  const d1 = await tx.driver.create({ data: { tenantId: t.id, name: 'Carlos Rojas', licenseNo: 'Q-1001', licenseCategory: 'A-IIIc', licenseExpiry: at(400), baseId: north.id, userId: c1u.id } })
  const d2 = await tx.driver.create({ data: { tenantId: t.id, name: 'Gonzalo Reyes', licenseNo: 'Q-1002', licenseCategory: 'A-IIIc', licenseExpiry: at(20), baseId: north.id } })
  const d3 = await tx.driver.create({ data: { tenantId: t.id, name: 'Beatriz Núñez', licenseNo: 'Q-1003', licenseCategory: 'A-IIb', licenseExpiry: at(-5), baseId: north.id } })
  const d4 = await tx.driver.create({ data: { tenantId: t.id, name: 'Iván Cárdenas', licenseNo: 'Q-1004', licenseCategory: 'A-IIIb', licenseExpiry: at(300), baseId: south.id, trainingPending: true } })

  const veh = (plate: string, cls: string, fleet: string, base: string, pax: number, kg: number, gps: string | null, extra: Partial<Prisma.VehicleUncheckedCreateInput> = {}) =>
    tx.vehicle.create({ data: { tenantId: t.id, plate, vehicleClass: cls, fleetId: fleet, baseId: base, capacityPassengers: pax, capacityKg: kg, fuel: 'Diésel', odometerKm: 120_000, gpsDeviceId: gps, lifecycle: 'DISPONIBLE', ...extra } })
  const v1 = await veh('BUS-101', 'Bus interurbano', buses.id, north.id, 44, 1500, `GPS-${o.slug}-101`)
  const v2 = await veh('BUS-102', 'Bus interurbano', buses.id, north.id, 44, 1500, `GPS-${o.slug}-102`)
  const v3 = await veh('BUS-103', 'Bus interurbano', buses.id, north.id, 44, 1500, `GPS-${o.slug}-103`, { blocked: true, blockReason: 'Falla de frenos detectada en inspección', blockedById: mant.id })
  const v4 = await veh('MIN-201', 'Minibús', buses.id, north.id, 20, 600, null)
  const v5 = await veh('CAM-301', 'Camión de carga', trucks.id, south.id, 2, 12_000, `GPS-${o.slug}-301`)
  const doc = (resourceType: 'VEHICULO' | 'CONDUCTOR', resourceId: string, label: string, docType: string, expiresInDays: number, critical: boolean) =>
    tx.complianceDocument.create({ data: { tenantId: t.id, resourceType, resourceId, resourceLabel: label, docType, number: `${docType.slice(0, 3).toUpperCase()}-${randomBytes(3).toString('hex')}`, issuedAt: at(-300), expiresAt: at(expiresInDays), critical, createdBy: 'Semilla DEMO' } })
  for (const v of [v1, v2, v4, v5]) await doc('VEHICULO', v.id, v.plate, 'SOAT', 200, true)
  await doc('VEHICULO', v1.id, v1.plate, 'Revisión técnica', 12, true) // por vencer → Condicionado
  await doc('VEHICULO', v2.id, v2.plate, 'Revisión técnica', -3, true) // vencido → No habilitado
  await doc('VEHICULO', v4.id, v4.plate, 'Revisión técnica', 150, true)
  await doc('CONDUCTOR', d2.id, d2.name, 'Certificado médico', 25, false)
  await tx.maintenanceOrder.create({ data: { tenantId: t.id, code: `OT-${await counter(tx, t.id, 'maintenance', 100)}`, vehicleId: v3.id, vehiclePlate: v3.plate, kind: 'CORRECTIVO', status: 'PROGRAMADA', scheduledAt: at(-1), description: 'Cambio de pastillas y discos', critical: true, createdBy: mant.name } })

  const route = (name: string, origin: string, destination: string, base: string, points: { name: string; lat: number; lon: number; stop?: string | null }[]) =>
    tx.route.create({
      data: {
        tenantId: t.id, name, origin, destination, points, speedLimitKmh: 90, distanceKm: 420, version: 1, status: 'AUTORIZADA', baseId: base, authorizedAlternatives: [], createdBy: programador.name,
        geofences: [{ id: `${name}-o`, name: origin, lat: points[0]!.lat, lon: points[0]!.lon, radiusM: 400 }, { id: `${name}-d`, name: destination, lat: points[points.length - 1]!.lat, lon: points[points.length - 1]!.lon, radiusM: 400 }],
      },
    })
  const r1 = await route('Lima – Trujillo', 'Lima', 'Trujillo', north.id, [
    { name: 'Terminal Lima', lat: -12.0464, lon: -77.0428, stop: 'Sube' }, { name: 'Huacho', lat: -11.1067, lon: -77.605, stop: 'Sube y baja' },
    { name: 'Chimbote', lat: -9.0853, lon: -78.5783, stop: 'Sube y baja' }, { name: 'Terminal Trujillo', lat: -8.1116, lon: -79.0288, stop: 'Baja' },
  ])
  const r2 = await route('Puerto – Almacén Sur', 'Puerto Callao', 'Almacén Lurín', south.id, [{ name: 'Puerto Callao', lat: -12.05, lon: -77.14 }, { name: 'Almacén Lurín', lat: -12.27, lon: -76.87 }])

  const trip = async (d: { route: typeof r1; v?: typeof v1 | null; dr?: typeof d1 | null; life: Prisma.TripUncheckedCreateInput['lifecycle']; dep: number; eta: number; dispatch?: boolean; creator?: string }) => {
    const code = `VJ-${await counter(tx, t.id, 'trip', 1000)}`
    const base = d.route.baseId === north.id ? north : south
    const tr = await tx.trip.create({
      data: {
        tenantId: t.id, code, routeId: d.route.id, routeName: d.route.name, routeVersion: 1, baseId: base.id, baseName: base.name, plannedDeparture: at(0, d.dep), plannedEta: at(0, d.eta),
        vehicleId: d.v?.id ?? null, vehiclePlate: d.v?.plate ?? null, driverId: d.dr?.id ?? null, driverName: d.dr?.name ?? null, priority: 'NORMAL', instructions: '', lifecycle: d.life,
        createdBy: programador.name, createdByUserId: d.creator ?? programador.id, dispatchAuthorized: !!d.dispatch, startedAt: d.life === 'EN_RUTA' ? at(0, d.dep) : null,
      },
    })
    await tx.tripEvent.create({ data: { tenantId: t.id, tripId: tr.id, actor: programador.name, kind: 'PLAN', summary: 'Viaje creado y planificado', at: at(-1) } })
    if (d.v && d.dr) await tx.tripEvent.create({ data: { tenantId: t.id, tripId: tr.id, actor: programador.name, kind: 'ASIGNACION', summary: `Asignado ${d.v.plate} / ${d.dr.name}`, at: at(-1, 1) } })
    if (d.dispatch) await tx.tripEvent.create({ data: { tenantId: t.id, tripId: tr.id, actor: 'Diego Farfán', kind: 'DESPACHO', summary: 'Despacho autorizado (POL-001)', at: at(0, d.dep) } })
    if (d.life === 'EN_RUTA') await tx.tripEvent.create({ data: { tenantId: t.id, tripId: tr.id, actor: 'Carlos Rojas', kind: 'EJECUCION', summary: 'Inicio efectivo confirmado', at: at(0, d.dep) } })
    return tr
  }
  const enRuta = await trip({ route: r1, v: v1, dr: d1, life: 'EN_RUTA', dep: -3, eta: 4, dispatch: true })
  await trip({ route: r1, v: v4, dr: d2, life: 'ASIGNADO', dep: 5, eta: 12 }) // gate con advertencias (sin GPS, licencia/cert. por vencer)
  await trip({ route: r1, v: v2, dr: d3, life: 'ASIGNADO', dep: 8, eta: 15 }) // gate No habilitado (documento vencido + licencia vencida)
  await trip({ route: r1, life: 'PLANIFICADO', dep: 30, eta: 37 })
  await trip({ route: r2, v: v5, dr: d4, life: 'LISTO_PARA_SALIDA', dep: 2, eta: 4, creator: jefe.id })
  await tx.vehicleLastPosition.create({ data: { vehicleId: v1.id, tenantId: t.id, tripId: enRuta.id, lat: -11.2, lon: -77.55, speedKmh: 86, heading: 320, ignition: true, sourceTime: new Date(now - 30_000) } })
  await tx.telemetryEvent.create({ data: { tenantId: t.id, vehicleId: v1.id, deviceId: v1.gpsDeviceId!, sourceTime: new Date(now - 30_000), lat: -11.2, lon: -77.55, speedKmh: 86 } })

  const alert = await tx.alert.create({ data: { tenantId: t.id, kind: 'EXCESO_VELOCIDAD', severity: 'ALTA', detail: 'BUS-101 a 104 km/h (límite 90 km/h + 10%).', dedupeKey: `speed:${enRuta.id}`, tripId: enRuta.id, tripCode: enRuta.code, vehicleId: v1.id, vehiclePlate: v1.plate, requiresReview: true } })
  await tx.tripEvent.create({ data: { tenantId: t.id, tripId: enRuta.id, actor: 'Sistema', kind: 'ALERTA', summary: `Exceso de velocidad: ${alert.detail}` } })
  await tx.incident.create({ data: { tenantId: t.id, code: `INC-${await counter(tx, t.id, 'incident', 100)}`, category: 'MECANICA', severity: 'MEDIA', status: 'CLASIFICADA', tripId: enRuta.id, tripCode: enRuta.code, vehicleId: v1.id, vehiclePlate: v1.plate, description: 'Luz de aceite intermitente reportada por el conductor.', reportedBy: 'Carlos Rojas', reportedById: c1u.id, requiresReview: false, occurredAt: at(0, -1) } })
  await tx.integrationCredential.create({ data: { tenantId: t.id, kind: 'telemetry', label: 'Proveedor GPS (demo)', keyHash: createHash('sha256').update(`demo-telemetry-key-${o.slug}-000000000000`).digest('hex') } })
  return t
}

async function main() {
  if (await db.tenant.findUnique({ where: { slug: 'andina' } })) {
    console.log('La semilla DEMO ya existe (slug «andina»). No se duplica.')
    return
  }
  const hash = await bcrypt.hash(PASSWORD, 10)
  await db.$transaction(
    async (tx) => {
      await user(tx, hash, null, 'SuperAdmin Nativo', 'superadmin@plataforma.demo', ['ROL-001'], [{ type: 'PLATFORM', label: 'Plataforma' }], { isNative: true })
      await tenantDemo(tx, hash, { slug: 'andina', name: 'Transportes Andina', lifecycle: 'ACTIVO', plan: 'BUSINESS', subEndsInDays: 120, full: true })
      await tenantDemo(tx, hash, { slug: 'sur', name: 'Transportes del Sur', lifecycle: 'ACTIVO', plan: 'STARTER', subEndsInDays: 3, full: true })
      await tenantDemo(tx, hash, { slug: 'delta', name: 'Logística Delta', lifecycle: 'SUSPENDIDO', plan: 'STARTER', subEndsInDays: 60, full: false, reason: 'Suspendido por solicitud administrativa (demo EXC-002).' })
    },
    { timeout: 120_000 },
  )
  console.log('Semilla DEMO creada.')
  console.log(`  Contraseña de todas las cuentas: ${PASSWORD}`)
  console.log('  Plataforma (sin slug): superadmin@plataforma.demo')
  console.log('  Negocio «andina»: jefe@, flota@, rutas@, despacho@, control@, conductor@, mantenimiento@, seguridad@, carga@, pasajeros@, pasajero@, admin@, owner@ (dominio andina.demo)')
  console.log('  Negocio «delta»: suspendido (EXC-002).')
  console.log('  Telemetría demo: X-Integration-Key = demo-telemetry-key-andina-000000000000')
}

main()
  .catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void db.$disconnect())
