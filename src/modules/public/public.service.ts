import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { RequestContext } from '../../common/context/request-context'
import { Errors } from '../../common/errors/app-error'
import { PAX_DOC, TRIP_LIFECYCLE } from '../../common/labels'
import { clean } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import { routeProgress } from '../monitoring/domain/geo'
import { PassengersService } from '../passengers/passengers.service'
import { parsePoints } from '../planning/domain/stops'
import { PlatformSettingsReader } from '../platform/platform-settings.reader'

/** Latencia mínima de la búsqueda pública: la respuesta tarda lo mismo encuentre o no (no revela por temporización). */
const MIN_LOOKUP_MS = 250

/**
 * Endpoints SIN sesión (PC-A17 «mi reserva», PC-A20 cartelera, ajuste público del Login).
 * Alcance: UN negocio configurado (PUBLIC_TENANT_SLUG) mientras no exista enlace público por empresa (decisión pendiente).
 * Nunca exponen datos internos, de otros pasajeros ni de clientes; los documentos viajan por POST (no quedan en logs de URL).
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passengers: PassengersService,
    private readonly settings: PlatformSettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Tenant público configurado (system client: todavía no hay contexto de tenant). `null` = función no habilitada. */
  private async publicTenant() {
    if (!this.config.publicTenantSlug) return null
    const t = await this.prisma.system.tenant.findUnique({ where: { slug: this.config.publicTenantSlug } })
    return t && ['ACTIVO', 'REACTIVADO'].includes(t.lifecycle) ? t : null
  }

  async quickAccessCardsEnabled(): Promise<boolean> {
    // Solo tiene efecto en builds DEMO del FE; en producción el ajuste debe quedar apagado.
    return (await this.settings.get()).quickAccessCardsEnabled
  }

  async terminals() {
    const t = await this.publicTenant()
    if (!t) return []
    return RequestContext.asTenant(t.id, async () => {
      const bases = await this.prisma.db.orgUnit.findMany({ where: { type: 'BASE', active: true }, orderBy: { name: 'asc' } })
      return bases.map((b) => ({ id: b.id, name: b.name, city: b.city ?? '', operatorName: t.name }))
    })
  }

  /** Cartelera del día en la zona horaria del negocio (un viaje de madrugada no se corre de día por UTC). */
  async schedule(baseId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Errors.field('date', 'Use el formato AAAA-MM-DD.')
    const t = await this.publicTenant()
    if (!t) return []
    return RequestContext.asTenant(t.id, async () => {
      const db = this.prisma.db
      // Ventana amplia (±1 día UTC) y filtro exacto por fecha local de la zona del negocio.
      const from = new Date(`${date}T00:00:00Z`)
      const trips = await db.trip.findMany({
        where: { baseId, lifecycle: { notIn: ['BORRADOR'] }, plannedDeparture: { gte: new Date(from.getTime() - 86_400_000), lt: new Date(from.getTime() + 2 * 86_400_000) } },
        orderBy: { plannedDeparture: 'asc' },
      })
      const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone }).format(d)
      const day = trips.filter((x) => local(x.plannedDeparture) === date)
      const [routes, delays, positions] = await Promise.all([
        db.route.findMany({ where: { id: { in: day.map((x) => x.routeId) } }, select: { id: true, origin: true, destination: true, points: true } }),
        db.alert.findMany({ where: { tripId: { in: day.map((x) => x.id) }, kind: 'RETRASO', status: { notIn: ['RESUELTA', 'CERRADA'] } }, select: { tripId: true } }),
        db.vehicleLastPosition.findMany({ where: { tripId: { in: day.map((x) => x.id) } } }),
      ])
      return day.map((x) => {
        const r = routes.find((y) => y.id === x.routeId)
        const pos = positions.find((y) => y.tripId === x.id)
        const pts = r ? parsePoints(r.points) : []
        return {
          id: x.id, code: x.code, routeName: x.routeName, origin: r?.origin ?? '', destination: r?.destination ?? '',
          plannedDeparture: x.plannedDeparture.toISOString(), plannedEta: x.plannedEta.toISOString(), etaUpdated: x.etaUpdated?.toISOString() ?? null,
          lifecycle: TRIP_LIFECYCLE.label(x.lifecycle), delayed: delays.some((d) => d.tripId === x.id),
          arriving: x.lifecycle === 'EN_RUTA' && !!pos && pts.length >= 2 && routeProgress({ lat: pos.lat, lon: pos.lon }, pts) >= 0.9, vehiclePlate: x.vehiclePlate,
        }
      })
    })
  }

  /** Documento + apellido paterno EXACTOS; cada llamada vuelve a validar la identidad completa. */
  private async findRows(i: { documentType: string; document: string; lastNamePaternal: string }) {
    const t = await this.publicTenant()
    const type = PAX_DOC.parse(i.documentType)
    const doc = clean(i.document).toUpperCase()
    const paternal = clean(i.lastNamePaternal)
    if (!t || !type || !doc || !paternal) return { tenantId: null, rows: [] }
    const rows = await RequestContext.asTenant(t.id, () =>
      this.prisma.db.passengerBooking.findMany({ where: { documentType: type, document: doc, lastNamePaternal: { equals: paternal, mode: 'insensitive' } } }),
    )
    return { tenantId: t.id, rows }
  }

  async findBookings(i: { documentType: string; document: string; lastNamePaternal: string }) {
    const started = Date.now()
    const { tenantId, rows } = await this.findRows(i)
    const out = tenantId ? await RequestContext.asTenant(tenantId, () => this.passengers.portalView(this.prisma.db, rows)) : []
    const wait = MIN_LOOKUP_MS - (Date.now() - started)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    return out
  }

  async cancelBooking(id: string, i: { documentType: string; document: string; lastNamePaternal: string; reason?: string }) {
    const { tenantId, rows } = await this.findRows(i)
    const x = rows.find((r) => r.id === id)
    if (!tenantId || !x) throw Errors.unavailable() // ni la existencia de reservas ajenas se revela
    return RequestContext.asTenant(tenantId, () => this.prisma.tx((tx) => this.passengers.cancelOwn(tx, x, i.reason, `${x.firstNames} ${x.lastNamePaternal} (sin cuenta)`, 'passenger.public.cancel')))
  }
}
