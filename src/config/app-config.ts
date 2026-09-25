/**
 * Configuración tipada y validada al arrancar (DOC-E-BE §Y · startup checks).
 * Ningún valor operativo se hardcodea como norma: los umbrales de GAP-009 y las vigencias de sesión son SUPUESTOS TÉCNICOS
 * configurables hasta que DOC-A / DOC-G-SEC los fijen.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production'
  port: number
  apiPrefix: string
  /** Rol de la aplicación (`transportes_app`): SIN superusuario ni BYPASSRLS; PostgreSQL le aplica el aislamiento por tenant (RLS). */
  databaseUrl: string
  /** Rol de plataforma (`transportes_platform`, BYPASSRLS): solo autenticación, consola de plataforma, jobs y endpoints públicos. */
  databaseSystemUrl: string
  corsOrigins: string[]
  auth: {
    accessSecret: string
    accessTtlSeconds: number
    refreshTtlDays: number
    refreshCookieName: string
    cookieSecure: boolean
    bcryptCost: number
    maxFailedLogins: number
    lockMinutes: number
  }
  ops: {
    positionFreshSeconds: number
    signalLostSeconds: number
    docExpiringDays: number
    speedTolerancePct: number
    delayToleranceMinutes: number
    arrivalOnTimeToleranceMinutes: number
    defaultTimezone: string
    /** Distancia máxima al trazado de la ruta antes de alertar desvío (RF-019 · SUPUESTO GAP-009). */
    routeCorridorMeters: number
  }
  http: { trustProxy: boolean; authRateLimitPerMin: number }
  storage: { driver: 'local'; localDir: string; signingSecret: string; publicBaseUrl: string }
  jobsEnabled: boolean
  swaggerEnabled: boolean
  publicTenantSlug: string | null
}

export class ConfigError extends Error {}

const str = (env: NodeJS.ProcessEnv, key: string, fallback?: string): string => {
  const v = env[key]?.trim()
  if (v) return v
  if (fallback !== undefined) return fallback
  throw new ConfigError(`Falta la variable de entorno obligatoria ${key}`)
}
const int = (env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[key]?.trim()
  const n = raw ? Number(raw) : fallback
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} debe ser un entero entre ${min} y ${max}`)
  return n
}
const bool = (env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ConfigError(`${key} debe ser true o false`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Fail-safe: sin NODE_ENV se asume producción (exige secretos reales y cookie segura). Los valores de desarrollo
  // (secretos de relleno, Swagger, cookie no segura) solo aplican si NODE_ENV=development|test se declara explícitamente.
  const nodeEnv = str(env, 'NODE_ENV', 'production')
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new ConfigError('NODE_ENV inválido')
  const prod = nodeEnv === 'production'
  const secret = (key: string) => {
    const v = str(env, key, prod ? undefined : `dev-only-${key}-not-for-production-000000`)
    if (v.length < 32) throw new ConfigError(`${key} debe tener al menos 32 caracteres`)
    if (v.startsWith('dev-only-')) {
      if (prod) throw new ConfigError(`${key} usa un secreto de relleno de desarrollo: configure un secreto real`)
    }
    if (prod && v.startsWith('change-me')) throw new ConfigError(`${key} conserva el valor de ejemplo: configure un secreto real`)
    return v
  }
  const cookieSecure = bool(env, 'COOKIE_SECURE', prod)
  if (prod && !cookieSecure) throw new ConfigError('COOKIE_SECURE debe ser true en producción (ADR-003)')
  const databaseUrl = str(env, 'DATABASE_URL', prod ? undefined : 'postgresql://postgres:postgres@localhost:5432/transportes?schema=public')
  // Producción exige DOS roles distintos: si ambos fueran el mismo, la RLS no protegería nada.
  const databaseSystemUrl = prod ? str(env, 'DATABASE_SYSTEM_URL') : str(env, 'DATABASE_SYSTEM_URL', databaseUrl)
  if (prod && databaseSystemUrl === databaseUrl) throw new ConfigError('DATABASE_SYSTEM_URL debe usar un rol distinto de DATABASE_URL (aislamiento por tenant con RLS)')
  return {
    env: nodeEnv as AppConfig['env'],
    port: int(env, 'PORT', 3000, 1, 65535),
    apiPrefix: str(env, 'API_PREFIX', 'api/v1').replace(/^\/+|\/+$/g, ''),
    databaseUrl,
    databaseSystemUrl,
    corsOrigins: str(env, 'CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    auth: {
      accessSecret: secret('JWT_ACCESS_SECRET'),
      accessTtlSeconds: int(env, 'ACCESS_TOKEN_TTL_SECONDS', 900, 60, 3600),
      refreshTtlDays: int(env, 'REFRESH_TOKEN_TTL_DAYS', 7, 1, 90),
      refreshCookieName: str(env, 'REFRESH_COOKIE_NAME', 'tr_refresh'),
      cookieSecure,
      bcryptCost: int(env, 'BCRYPT_COST', prod ? 12 : 10, 4, 15),
      maxFailedLogins: int(env, 'LOGIN_MAX_FAILED', 5, 3, 20),
      lockMinutes: int(env, 'LOGIN_LOCK_MINUTES', 15, 1, 1440),
    },
    ops: {
      positionFreshSeconds: int(env, 'POSITION_FRESH_SECONDS', 90, 10, 3600),
      signalLostSeconds: int(env, 'SIGNAL_LOST_SECONDS', 600, 60, 86400),
      docExpiringDays: int(env, 'DOC_EXPIRING_DAYS', 30, 1, 365),
      speedTolerancePct: int(env, 'SPEED_TOLERANCE_PCT', 10, 0, 100),
      delayToleranceMinutes: int(env, 'DELAY_TOLERANCE_MINUTES', 15, 0, 1440),
      arrivalOnTimeToleranceMinutes: int(env, 'ARRIVAL_ON_TIME_TOLERANCE_MINUTES', 15, 0, 1440),
      defaultTimezone: str(env, 'DEFAULT_TIMEZONE', 'America/Lima'),
      routeCorridorMeters: int(env, 'ROUTE_CORRIDOR_METERS', 1500, 50, 100_000),
    },
    http: { trustProxy: bool(env, 'TRUST_PROXY', false), authRateLimitPerMin: int(env, 'AUTH_RATE_LIMIT_PER_MIN', 20, 1, 100_000) },
    storage: {
      driver: 'local',
      localDir: str(env, 'STORAGE_LOCAL_DIR', './storage'),
      signingSecret: secret('FILES_SIGNING_SECRET'),
      publicBaseUrl: str(env, 'PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    },
    jobsEnabled: bool(env, 'JOBS_ENABLED', true),
    swaggerEnabled: bool(env, 'SWAGGER_ENABLED', !prod),
    publicTenantSlug: env.PUBLIC_TENANT_SLUG?.trim() || null,
  }
}

/**
 * Lecturas puntuales que ocurren ANTES de que exista el contenedor de Nest (adaptador HTTP, decoradores estáticos).
 * Usan los mismos validadores que `loadConfig`, de modo que no hay un segundo camino sin validar hacia `process.env`.
 */
export const trustProxyFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => bool(env, 'TRUST_PROXY', false)
export const authRateLimitFromEnv = (env: NodeJS.ProcessEnv = process.env): number => int(env, 'AUTH_RATE_LIMIT_PER_MIN', 20, 1, 100_000)

export const APP_CONFIG = Symbol('APP_CONFIG')
