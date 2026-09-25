import { Injectable } from '@nestjs/common'
import type { Tx } from '../database/prisma.service'

/** Primer número visible de cada serie (continuidad con los códigos que ya conoce el negocio en la demo). */
const START: Record<string, number> = { trip: 1000, incident: 100, maintenance: 100, cargo: 3000, booking: 4000, service: 200 }
const PREFIX: Record<string, string> = { trip: 'VJ', incident: 'INC', maintenance: 'OT', cargo: 'CG', booking: 'PX', service: 'SV' }

export type CounterName = keyof typeof PREFIX

/**
 * Códigos visibles por negocio (VJ-1001, INC-101…). Incremento atómico con INSERT … ON CONFLICT dentro de la transacción
 * del caso de uso: dos altas concurrentes nunca obtienen el mismo código y un rollback no «quema» números visibles.
 */
@Injectable()
export class CountersService {
  async next(tx: Tx, tenantId: string, name: CounterName): Promise<string> {
    const start = START[name] ?? 0
    const rows = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO "tenant_counter" ("tenantId", "name", "value") VALUES (${tenantId}::uuid, ${name}, ${start + 1})
      ON CONFLICT ("tenantId", "name") DO UPDATE SET "value" = "tenant_counter"."value" + 1
      RETURNING "value"`
    const value = rows[0]?.value
    if (value === undefined) throw new Error('No se pudo reservar el código')
    return `${PREFIX[name]}-${value}`
  }
}
