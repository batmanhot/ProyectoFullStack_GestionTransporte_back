import { hasRole, type Principal } from './principal'

/**
 * Alcance de datos (DOC-A §J · POL-002 · CTRL-012). El permiso responde «qué puede hacer»; el alcance, «sobre qué registros».
 * - TENANT/ORGANIZATION ⇒ todo el negocio.
 * - BASE / FLEET ⇒ solo registros de esas terminales / flotas.
 * - OWN_RECORDS (conductor, pasajero) y CUSTOMER_ORG (cliente) se resuelven en cada módulo con su propia regla.
 */
export class DataScope {
  readonly tenantWide: boolean
  readonly bases: ReadonlySet<string>
  readonly fleets: ReadonlySet<string>
  readonly customerOrgs: ReadonlySet<string>

  constructor(readonly principal: Principal) {
    const s = principal.scopes
    this.tenantWide = s.some((x) => x.type === 'TENANT' || x.type === 'ORGANIZATION' || x.type === 'PLATFORM')
    this.bases = new Set(s.filter((x) => x.type === 'BASE' && x.id).map((x) => x.id as string))
    this.fleets = new Set(s.filter((x) => x.type === 'FLEET' && x.id).map((x) => x.id as string))
    this.customerOrgs = new Set(s.filter((x) => x.type === 'CUSTOMER_ORG' && x.id).map((x) => x.id as string))
  }

  get isDriver(): boolean {
    return hasRole(this.principal, 'ROL-008') && !this.tenantWide && this.bases.size === 0
  }
  get isCustomer(): boolean {
    return hasRole(this.principal, 'ROL-013') && !this.tenantWide && this.bases.size === 0
  }
  /** Tiene visibilidad de flota (para contadores del centro de control: `null` = sin visibilidad, nunca 0 falso). */
  get seesFleet(): boolean {
    return this.tenantWide || this.bases.size > 0 || this.fleets.size > 0
  }

  covers(baseId: string | null | undefined, fleetId?: string | null): boolean {
    if (this.tenantWide) return true
    if (baseId && this.bases.has(baseId)) return true
    return !!fleetId && this.fleets.has(fleetId)
  }

  /** Filtro Prisma para modelos con `baseId` (y opcionalmente `fleetId`). `undefined` = sin restricción adicional. */
  baseWhere(withFleet = false): { OR: Record<string, { in: string[] }>[] } | undefined {
    if (this.tenantWide) return undefined
    const or: Record<string, { in: string[] }>[] = [{ baseId: { in: [...this.bases] } }]
    if (withFleet && this.fleets.size) or.push({ fleetId: { in: [...this.fleets] } })
    return { OR: or }
  }
}
