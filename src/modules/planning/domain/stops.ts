/**
 * Paradas y tramos de pasajeros (PC-A6, decisión de negocio): las paradas son OPCIONALES. Sin paradas marcadas el viaje es
 * directo (origen → destino). Un asiento solo está ocupado durante el tramo de su pasajero y se reutiliza cuando baja.
 * Mismo algoritmo que `core/domain/stops.ts` del FE, pero aquí es la AUTORIDAD.
 */
export type StopKind = 'Sube' | 'Baja' | 'Sube y baja'
export interface RoutePoint {
  name: string
  lat: number
  lon: number
  stop?: StopKind | null
}
export interface RouteStop {
  name: string
  kind: StopKind
}

export function routeStops(points: RoutePoint[]): RouteStop[] {
  const configured = points.filter((p) => p.stop).map((p) => ({ name: p.name, kind: p.stop as StopKind }))
  if (configured.length >= 2) return configured
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2) return []
  return [
    { name: first.name, kind: 'Sube' },
    { name: last.name === first.name ? `${last.name} (destino)` : last.name, kind: 'Baja' },
  ]
}

export const PASSENGER_CLASSES = ['Bus interurbano', 'Minibús']
/** Estados que ocupan asiento (la no presentada y la cancelada lo liberan). */
export const SEATED = ['RESERVADA', 'ABORDO', 'LLEGO'] as const
export const canBoard = (s: RouteStop) => s.kind !== 'Baja'
export const canAlight = (s: RouteStop) => s.kind !== 'Sube'

export type Span = [from: number, to: number]
export const spanOf = (stops: RouteStop[], board: string, alight: string): Span => [stops.findIndex((s) => s.name === board), stops.findIndex((s) => s.name === alight)]
/** Coinciden en algún tramo (subir justo donde el otro baja NO coincide). */
export const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1]

export interface Seated {
  id: string
  seat: number
  status: string
  boardStop: string
  alightStop: string
}
const isSeated = (s: string) => (SEATED as readonly string[]).includes(s)

export const seatsTakenIn = (stops: RouteStop[], items: Seated[], span: Span, exceptId?: string) =>
  new Set(items.filter((x) => isSeated(x.status) && x.id !== exceptId && overlaps(spanOf(stops, x.boardStop, x.alightStop), span)).map((x) => x.seat))

export const freeSeatsIn = (capacity: number, taken: Set<number>) => Array.from({ length: capacity }, (_, i) => i + 1).filter((n) => !taken.has(n))

export const onBoardBySegment = (stops: RouteStop[], items: Seated[]) =>
  Array.from({ length: Math.max(0, stops.length - 1) }, (_, k) =>
    items.filter((x) => {
      const [f, t] = spanOf(stops, x.boardStop, x.alightStop)
      return isSeated(x.status) && f <= k && k < t
    }).length,
  )

export const peakOccupancy = (stops: RouteStop[], items: Seated[]) => Math.max(0, ...onBoardBySegment(stops, items))

/** Lectura defensiva de los puntos guardados como JSON. */
export function parsePoints(json: unknown): RoutePoint[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((p: unknown) => {
    if (!p || typeof p !== 'object') return []
    const o = p as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.lat !== 'number' || typeof o.lon !== 'number') return []
    const stop = o.stop === 'Sube' || o.stop === 'Baja' || o.stop === 'Sube y baja' ? o.stop : null
    return [{ name: o.name, lat: o.lat, lon: o.lon, stop }]
  })
}
