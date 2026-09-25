import { Param, type PipeTransform, Query } from '@nestjs/common'
import { Errors } from '../errors/app-error'
import type { RawQuery } from './list-query'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Un id mal formado responde igual que uno inexistente o ajeno: no revela nada (RN-010). */
class IdPipe implements PipeTransform<unknown, string> {
  transform(v: unknown): string {
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw Errors.unavailable()
    return v.toLowerCase()
  }
}

export const IdParam = (name = 'id') => Param(name, new IdPipe())
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** Query string cruda (los filtros se validan contra la lista blanca de cada endpoint en `parseListQuery`). */
export const RawQueryParams = () => Query()
export type { RawQuery }

/** Texto de entrada normalizado. */
export const clean = (s: string | null | undefined) => (s ?? '').trim()
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
export const parseDate = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
export const MS_DAY = 86_400_000
