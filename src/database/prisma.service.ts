import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../generated/prisma/client'
import { APP_CONFIG, type AppConfig } from '../config/app-config'
import { setTenantSql, tenantIsolation } from './tenant-isolation.extension'
import { RequestContext } from '../common/context/request-context'

export type Tx = Prisma.TransactionClient

/**
 * Acceso a PostgreSQL con DOS roles de base de datos (aislamiento por tenant en profundidad, ver DOC-E-BE §I):
 *  - `db`     → rol `transportes_app` (sin BYPASSRLS): aislamiento de tenant obligatorio en la aplicación Y en PostgreSQL (RLS).
 *               Uso por defecto de todos los módulos de negocio.
 *  - `system` → rol `transportes_platform` (BYPASSRLS): SOLO autenticación, consola de plataforma, jobs y endpoints públicos,
 *               que filtran por tenant de forma explícita y auditada. Cada uso debe justificarse en el código.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Database')
  readonly system: PrismaClient
  readonly db: PrismaClient
  private readonly app: PrismaClient

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.system = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseSystemUrl }) })
    this.app = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) })
    // El cliente extendido conserva la forma de PrismaClient: la extensión solo intercepta consultas.
    this.db = this.app.$extends(tenantIsolation(this.app as never)) as unknown as PrismaClient
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.system.$connect(), this.app.$connect()])
    await this.assertAppRoleIsConfined()
    this.log.log('Conexión a PostgreSQL establecida')
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.system.$disconnect(), this.app.$disconnect()])
  }

  /**
   * Arranque fail-closed: si el rol de la aplicación es superusuario o tiene BYPASSRLS, PostgreSQL NO aplicaría las políticas
   * de aislamiento. En producción la API no arranca; en desarrollo se advierte (el aislamiento de aplicación sigue activo).
   */
  private async assertAppRoleIsConfined(): Promise<void> {
    const [r] = await this.app.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    if (r && !r.rolsuper && !r.rolbypassrls) return
    const msg = `El rol de la aplicación «${r?.rolname ?? '?'}» es superusuario o tiene BYPASSRLS: PostgreSQL no aplicará el aislamiento por tenant (RLS). Use el rol transportes_app (prisma/sql/roles.sql).`
    if (this.config.env === 'production') throw new Error(msg)
    this.log.warn(msg)
  }

  /** Transacción con aislamiento de tenant en aplicación y en PostgreSQL (RLS con `app.tenant_id` de la sesión). */
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: { isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        // Antes de cualquier consulta: el tenant de la sesión para las políticas RLS (SET LOCAL: vive solo en esta transacción).
        await tx.$executeRaw(setTenantSql(RequestContext.tenantId()))
        return fn(tx)
      },
      { isolationLevel: opts?.isolationLevel, timeout: 15_000 },
    )
  }

  /** Transacción SIN aislamiento automático (plataforma/jobs). */
  systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.system.$transaction(fn, { timeout: 15_000 })
  }

  async ping(): Promise<boolean> {
    try {
      await Promise.all([this.system.$queryRaw`SELECT 1`, this.app.$queryRaw`SELECT 1`])
      return true
    } catch {
      return false
    }
  }
}
