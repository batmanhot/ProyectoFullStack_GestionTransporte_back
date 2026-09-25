import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { Prisma } from '../../generated/prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { Errors } from '../errors/app-error'

/** Vigencia de una clave (SUPUESTO TÉCNICO: cubre reintentos del outbox del conductor tras una jornada sin señal). */
export const IDEMPOTENCY_TTL_MS = 48 * 3_600_000

export interface StoredResponse {
  status: number
  body: unknown
}

/** JSON canónico (claves ordenadas): la misma intención produce el mismo hash aunque cambie el orden de los campos. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const requestHash = (parts: unknown) => createHash('sha256').update(canonical(parts)).digest('hex')

/**
 * Idempotencia (DOC-E-BE §R · ADR-002). La clave se aísla por tenant + usuario (una clave ajena nunca devuelve datos de otro).
 *   1ª vez: se reserva (IN_PROGRESS) y se ejecuta.
 *   Repetición con la misma intención y ya terminada: se devuelve la respuesta guardada, sin repetir el efecto.
 *   Repetición con OTRA intención: IDEMPOTENCY_CONFLICT.
 *   Repetición mientras la primera sigue en curso: RESOURCE_CONFLICT (reintentar luego).
 * Si el caso de uso falla, la reserva se libera para permitir reintentar con la misma clave.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  scopeKey(tenantId: string | null, userId: string, key: string): string {
    return `${tenantId ?? 'platform'}:${userId}:${key}`
  }

  async begin(scopeKey: string, hash: string): Promise<{ replay: StoredResponse } | { reserved: true }> {
    const db = this.prisma.system
    try {
      await db.idempotencyRecord.create({ data: { scopeKey, requestHash: hash, status: 'IN_PROGRESS', expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS) } })
      return { reserved: true }
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    }
    const prev = await db.idempotencyRecord.findUnique({ where: { scopeKey } })
    if (!prev) return this.begin(scopeKey, hash)
    if (prev.expiresAt < new Date()) {
      await db.idempotencyRecord.delete({ where: { scopeKey } })
      return this.begin(scopeKey, hash)
    }
    if (prev.requestHash !== hash) throw Errors.idempotency()
    if (prev.status !== 'DONE') throw Errors.conflict('Operación en curso', 'La misma operación todavía se está procesando. Reintente en unos segundos.')
    return { replay: { status: prev.httpStatus ?? 200, body: prev.response } }
  }

  async complete(scopeKey: string, res: StoredResponse): Promise<void> {
    await this.prisma.system.idempotencyRecord.update({
      where: { scopeKey },
      data: { status: 'DONE', httpStatus: res.status, response: (res.body ?? null) as Prisma.InputJsonValue },
    })
  }

  async release(scopeKey: string): Promise<void> {
    await this.prisma.system.idempotencyRecord.deleteMany({ where: { scopeKey, status: 'IN_PROGRESS' } })
  }

  async purgeExpired(): Promise<number> {
    const r = await this.prisma.system.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    return r.count
  }
}
