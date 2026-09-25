import { Test } from '@nestjs/testing'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from '../../src/app.module'
import { configureApp, createAdapter } from '../../src/bootstrap'
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config'

export const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo1234'
export const TELEMETRY_KEY = 'demo-telemetry-key-andina-000000000000'

export interface Res<T = unknown> {
  status: number
  body: T
  headers: Record<string, string | string[] | number | undefined>
}

/** Levanta la API COMPLETA en proceso (misma pila que producción: guards, filtros, pipes, parsers) sin abrir un puerto. */
export async function startApp(): Promise<{ app: NestFastifyApplication; call: <T = Record<string, unknown>>(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Res<T>> }> {
  process.env.JOBS_ENABLED = 'false'
  process.env.AUTH_RATE_LIMIT_PER_MIN = '1000'
  process.env.PUBLIC_TENANT_SLUG = 'andina'
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = mod.createNestApplication<NestFastifyApplication>(createAdapter(), { bodyParser: false, logger: ['error'] })
  await configureApp(app, app.get<AppConfig>(APP_CONFIG))
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  const call = async <T,>(method: string, url: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res<T>> => {
    const r = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: { 'content-type': 'application/json', 'x-client-version': '0.1.0', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      payload: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
    let body: unknown = r.body
    try {
      body = r.body ? JSON.parse(r.body) : null
    } catch {
      /* cuerpo no JSON */
    }
    return { status: r.statusCode, body: body as T, headers: r.headers }
  }
  return { app, call }
}

export async function login(call: Awaited<ReturnType<typeof startApp>>['call'], slug: string | null, email: string): Promise<string> {
  const r = await call<{ accessToken: string }>('POST', '/auth/login', { body: { ...(slug ? { slug } : {}), email, password: PASSWORD } })
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.accessToken
}
