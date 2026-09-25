/** Geometría mínima para reglas de monitoreo (sin dependencias ni proveedor cartográfico: INT-002 pendiente). */
export interface LatLon {
  lat: number
  lon: number
}

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Distancia (m) de un punto a un segmento, en proyección equirectangular local (suficiente para corredores de pocos km). */
export function pointToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const k = Math.cos(rad((a.lat + b.lat) / 2))
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return haversineM(p, { lat: ay + t * dy, lon: (ax + t * dx) / k })
}

/** Distancia (m) al trazado de la ruta (polilínea). */
export function distanceToRouteM(p: LatLon, points: LatLon[]): number {
  if (points.length === 0) return Infinity
  if (points.length === 1) return haversineM(p, points[0]!)
  let min = Infinity
  for (let i = 1; i < points.length; i++) min = Math.min(min, pointToSegmentM(p, points[i - 1]!, points[i]!))
  return min
}

/** Avance aproximado (0–1) a lo largo del trazado: proyecta la posición sobre el segmento más cercano. */
export function routeProgress(p: LatLon, points: LatLon[]): number {
  if (points.length < 2) return 0
  const segs = points.slice(1).map((b, i) => ({ a: points[i]!, b, len: haversineM(points[i]!, b) }))
  const total = segs.reduce((s, x) => s + x.len, 0) || 1
  let best = { d: Infinity, along: 0 }
  let acc = 0
  for (const s of segs) {
    const d = pointToSegmentM(p, s.a, s.b)
    if (d < best.d) {
      const fromA = haversineM(s.a, p)
      best = { d, along: acc + Math.min(s.len, Math.sqrt(Math.max(0, fromA ** 2 - d ** 2))) }
    }
    acc += s.len
  }
  return Math.max(0, Math.min(1, best.along / total))
}

export type Freshness = 'Actual' | 'Desactualizada' | 'No disponible'

/** RN-005: una posición vieja NUNCA se presenta como actual. Umbral configurable (GAP-009). */
export function classifyFreshness(sourceTime: Date | null, now: number, freshSeconds: number): { freshness: Freshness; ageSeconds: number | null } {
  if (!sourceTime) return { freshness: 'No disponible', ageSeconds: null }
  const age = Math.max(0, Math.round((now - sourceTime.getTime()) / 1000))
  return { freshness: age <= freshSeconds ? 'Actual' : 'Desactualizada', ageSeconds: age }
}
