import { Inject, Injectable, Logger } from '@nestjs/common'
import { Prisma } from '../../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { RequestContext } from '../../common/context/request-context'
import { PrismaService } from '../../database/prisma.service'

/** Una ejecución «colgada» más vieja que esto se considera abandonada (réplica caída) y libera el candado. */
const STALE_MS = 15 * 60_000

/**
 * Abstracción de jobs (prompt §20): hoy corre en proceso (@nestjs/schedule); la infraestructura definitiva (cola, worker
 * dedicado) la decide DOC-I-OPS sin cambiar los jobs. Exclusión mutua entre réplicas con un índice único parcial sobre
 * `job_run(job) WHERE status='RUNNING'` (seguro con pool de conexiones). Cada ejecución queda registrada (observabilidad).
 */
@Injectable()
export class JobRunner {
  private readonly log = new Logger('Jobs')
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(job: string, fn: () => Promise<string | void>): Promise<void> {
    if (!this.config.jobsEnabled) return
    const db = this.prisma.system
    await db.jobRun.updateMany({ where: { job, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_MS) } }, data: { status: 'ABANDONED', finishedAt: new Date() } })
    let runId: string
    try {
      runId = (await db.jobRun.create({ data: { job, status: 'RUNNING' } })).id
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return // otra réplica lo está ejecutando
      throw e
    }
    const started = Date.now()
    try {
      const detail = await RequestContext.run({ correlationId: `job:${job}:${runId}`, ip: null, userAgent: null, principal: null, tenantId: null }, fn)
      await db.jobRun.update({ where: { id: runId }, data: { status: 'OK', finishedAt: new Date(), detail: detail ? String(detail).slice(0, 500) : null } })
    } catch (e) {
      this.log.error(`Job ${job} falló: ${(e as Error).message}`)
      await db.jobRun.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), detail: (e as Error).message.slice(0, 500) } })
    } finally {
      if (Date.now() - started > 60_000) this.log.warn(`Job ${job} tardó ${Math.round((Date.now() - started) / 1000)} s`)
    }
  }

  /** Recorre los negocios operables ejecutando `fn` DENTRO del aislamiento de cada uno. */
  async forEachTenant(fn: (tenantId: string) => Promise<number>): Promise<number> {
    const tenants = await this.prisma.system.tenant.findMany({ where: { lifecycle: { in: ['ACTIVO', 'REACTIVADO'] } }, select: { id: true } })
    let total = 0
    for (const t of tenants) total += await RequestContext.asTenant(t.id, () => fn(t.id))
    return total
  }
}
