import { Injectable, Logger } from '@nestjs/common'
import { RequestContext } from '../../common/context/request-context'
import { PrismaService, type Tx } from '../../database/prisma.service'

export interface AuditInput {
  kind?: 'Negocio' | 'Seguridad'
  resourceType: string
  resourceId: string
  action: string
  result?: 'OK' | 'DENEGADO' | 'ERROR'
  reason?: string | null
  before?: string | null
  after?: string | null
  /** Por defecto, el tenant de la sesión. `null` explícito = evento de plataforma. */
  tenantId?: string | null
  /** Para eventos sin sesión (login fallido, reserva pública): nombre visible del actor. */
  actorName?: string
  actorUserId?: string | null
}

/** Límite de texto de antes/después: evita volcar objetos completos (y datos sensibles) en la auditoría. */
const clip = (s: string | null | undefined, n = 500) => (s == null ? null : s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * Audit Trail (DOC-E-BE §L · ADR-011 · RF-029 · NFR-005). Append-only (trigger en BD). La auditoría ≠ logs técnicos.
 * Para que la acción y su registro sean atómicos, los servicios pasan la transacción (`tx`) en la que operan.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit')
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Tx): Promise<void> {
    const ctx = RequestContext.get()
    const p = ctx?.principal ?? null
    const tenantId = input.tenantId !== undefined ? input.tenantId : (ctx?.tenantId ?? null)
    const client = tx ?? this.prisma.system
    await client.auditEvent.create({
      data: {
        kind: input.kind === 'Seguridad' ? 'SEGURIDAD' : 'NEGOCIO',
        tenantId,
        actorUserId: input.actorUserId !== undefined ? input.actorUserId : (p?.userId ?? null),
        actor: input.actorName ?? p?.name ?? 'Sistema',
        actorRoles: p?.roles ?? [],
        resourceType: input.resourceType,
        resourceId: clip(input.resourceId, 200) ?? '-',
        action: input.action,
        result: input.result ?? 'OK',
        reason: clip(input.reason),
        before: clip(input.before),
        after: clip(input.after),
        correlationId: ctx?.correlationId ?? 'system',
        ip: ctx?.ip ?? null,
        userAgent: clip(ctx?.userAgent, 300),
      },
    })
  }

  /** Para denegaciones: nunca debe fallar la respuesta de error por no poder auditar. */
  async recordSafe(input: AuditInput): Promise<void> {
    try {
      await this.record(input)
    } catch (e) {
      this.log.error(`No se pudo auditar ${input.action}: ${(e as Error).message}`)
    }
  }
}
