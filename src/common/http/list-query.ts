import { Errors } from '../errors/app-error'

/**
 * Contrato de listas (DOC-E-BE §K · ADR-002 · FE-CONTRACT-014):
 *   ?page=1&pageSize=25&search=texto&sort=-campo&<filtro>=<valor>
 * Respuesta: { items, total, page, pageSize, cutoffAt, overall, facets }.
 *  - `sort` y los filtros se validan contra una lista blanca por endpoint (sin nombres de campo libres ⇒ sin inyección).
 *  - `pageSize` tiene tope (100) para proteger al servidor.
 *  - `overall` y `facets` se calculan sobre el UNIVERSO AUTORIZADO (tenant + alcance), sin filtros ni búsqueda.
 */
export type Facets = Record<string, Record<string, number>>

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  cutoffAt: string
  overall?: number
  facets?: Facets
}

export interface ListQuery {
  page: number
  pageSize: number
  search: string | null
  sort: { field: string; dir: 'asc' | 'desc' } | null
  filters: Record<string, string>
}

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 25

export type RawQuery = Record<string, unknown>

const one = (v: unknown): string | undefined => {
  if (Array.isArray(v)) return one(v[0])
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number') return String(v)
  return undefined
}

export function parseListQuery(raw: RawQuery, spec: { sortable: readonly string[]; filters: readonly string[]; defaultSort?: ListQuery['sort'] }): ListQuery {
  const errors: { field: string; message: string }[] = []
  const pageRaw = one(raw.page)
  const sizeRaw = one(raw.pageSize)
  const page = pageRaw === undefined ? 1 : Number(pageRaw)
  const pageSize = sizeRaw === undefined ? DEFAULT_PAGE_SIZE : Number(sizeRaw)
  if (!Number.isInteger(page) || page < 1) errors.push({ field: 'page', message: 'page debe ser un entero ≥ 1.' })
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) errors.push({ field: 'pageSize', message: `pageSize debe estar entre 1 y ${MAX_PAGE_SIZE}.` })
  const search = one(raw.search) ?? null
  if (search && search.length > 100) errors.push({ field: 'search', message: 'La búsqueda admite hasta 100 caracteres.' })
  let sort = spec.defaultSort ?? null
  const sortRaw = one(raw.sort)
  if (sortRaw) {
    const desc = sortRaw.startsWith('-')
    const field = desc ? sortRaw.slice(1) : sortRaw
    if (!spec.sortable.includes(field)) errors.push({ field: 'sort', message: `No se puede ordenar por «${field}».` })
    else sort = { field, dir: desc ? 'desc' : 'asc' }
  }
  const filters: Record<string, string> = {}
  for (const key of spec.filters) {
    const v = one(raw[key])
    if (v !== undefined) {
      if (v.length > 120) errors.push({ field: key, message: 'Valor de filtro demasiado largo.' })
      else filters[key] = v
    }
  }
  if (errors.length) throw Errors.validation(errors)
  return { page, pageSize, search, sort, filters }
}

export const cutoff = () => new Date().toISOString()

export function facetCount<T>(items: T[], fn: (t: T) => string | string[] | null | undefined): Record<string, number> {
  const acc: Record<string, number> = {}
  for (const it of items) {
    const v = fn(it)
    if (v == null) continue
    for (const x of Array.isArray(v) ? v : [v]) acc[x] = (acc[x] ?? 0) + 1
  }
  return acc
}

/**
 * Paginación en memoria sobre el universo autorizado. Se usa SOLO donde el filtro depende de un valor DERIVADO por el
 * servidor (elegibilidad, condiciones, fase documental) y el universo es un maestro acotado por tenant (vehículos,
 * conductores, documentos, rutas, usuarios). Colecciones que crecen sin límite (viajes, alertas, auditoría…) paginan en SQL.
 * Riesgo registrado en DOC-E-BE §Z: revisar con la volumetría de GAP-005.
 */
export function pageInMemory<T>(
  universe: T[],
  q: ListQuery,
  opts: {
    search?: (t: T) => string
    filters?: Record<string, (t: T, v: string) => boolean>
    facets?: Record<string, (t: T) => string | string[] | null | undefined>
    sort?: Record<string, (t: T) => string | number | null>
  },
): Page<T> {
  const facets: Facets = {}
  for (const [k, fn] of Object.entries(opts.facets ?? {})) facets[k] = facetCount(universe, fn)
  let out = universe
  if (q.search && opts.search) {
    const s = q.search.toLowerCase()
    out = out.filter((t) => opts.search!(t).toLowerCase().includes(s))
  }
  for (const [k, v] of Object.entries(q.filters)) {
    const fn = opts.filters?.[k]
    if (fn) out = out.filter((t) => fn(t, v))
  }
  const key = q.sort && opts.sort?.[q.sort.field]
  if (q.sort && key) {
    const dir = q.sort.dir === 'desc' ? -1 : 1
    out = [...out].sort((a, b) => {
      const x = key(a)
      const y = key(b)
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })
      return r * dir
    })
  }
  const start = (q.page - 1) * q.pageSize
  return { items: out.slice(start, start + q.pageSize), total: out.length, page: q.page, pageSize: q.pageSize, cutoffAt: cutoff(), overall: universe.length, facets }
}

/** Cursor opaco para feeds (auditoría). Codifica la posición de keyset (instante + id). */
export const Cursor = {
  encode: (at: Date, id: string) => Buffer.from(JSON.stringify([at.toISOString(), id]), 'utf8').toString('base64url'),
  decode(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null
    try {
      const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new Error('shape')
      const at = new Date(parsed[0])
      if (Number.isNaN(at.getTime())) throw new Error('date')
      return { at, id: parsed[1] }
    } catch {
      throw Errors.field('cursor', 'Cursor inválido o vencido: vuelva a la primera página.')
    }
  },
}
