import { randomUUID } from 'node:crypto'
import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import type { INestApplication } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { trustProxyFromEnv, type AppConfig } from './config/app-config'
import { RequestContext } from './common/context/request-context'
import { MetricsService } from './common/observability/metrics.service'

const CORRELATION_RE = /^[A-Za-z0-9-]{8,64}$/

export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: 1_048_576, // 1 MB: la API no recibe binarios (los archivos van directo al almacenamiento, ADR-009)
    trustProxy: trustProxyFromEnv(),
    genReqId: () => randomUUID(),
    // Los tokens firmados de las URLs temporales de archivos superan el límite por defecto de 100 caracteres.
    routerOptions: { maxParamLength: 1024 },
    logger: false,
  })
}

/**
 * Configuración HTTP compartida por `main.ts` y las pruebas de contrato (misma pila en ambos).
 * - Correlation-Id (ADR-012): se acepta el del cliente si es válido; si no, se genera. Vuelve en la respuesta.
 * - Contexto por petición (AsyncLocalStorage) abierto en `onRequest` para toda la cadena asíncrona.
 * - Helmet (cabeceras seguras), cookies firmables, CORS con credenciales solo para orígenes declarados.
 */
export async function configureApp(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance()
  fastify.addHook('onRequest', (req, reply, done) => {
    const raw = req.headers['x-correlation-id']
    const given = Array.isArray(raw) ? raw[0] : raw
    const correlationId = given && CORRELATION_RE.test(given) ? given : randomUUID()
    reply.header('X-Correlation-Id', correlationId)
    const ua = req.headers['user-agent']
    RequestContext.run({ correlationId, ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null, principal: null, tenantId: null }, () => done())
  })
  // Observabilidad: una muestra por respuesta con la PLANTILLA de ruta (sin parámetros ni cuerpos).
  const metrics = app.get(MetricsService)
  fastify.addHook('onResponse', (req, reply, done) => {
    const ctx = RequestContext.get()
    metrics.record({ at: Date.now(), method: req.method, route: req.routeOptions.url ?? 'desconocida', status: reply.statusCode, latencyMs: reply.elapsedTime, tenantId: ctx?.tenantId ?? null, userId: ctx?.principal?.userId ?? null })
    done()
  })
  // JSON tolerante a cuerpo vacío (requiere NestFactory.create(..., { bodyParser: false })): acciones sin datos (refresh, logout, completar archivo…) se envían sin body.
  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch {
      done(Object.assign(new Error('El cuerpo JSON no es válido.'), { statusCode: 400 }), undefined)
    }
  })
  // Cualquier otro Content-Type con cuerpo VACÍO (p. ej. clientes que anteponen application/x-www-form-urlencoded a un POST sin datos) se trata como {}; con cuerpo real sigue siendo 415.
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, {})
    done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }), undefined)
  })
  // ADR-009: el adaptador local de almacenamiento recibe el binario (PDF/JPG/PNG ≤ 5 MB) como Buffer.
  fastify.addContentTypeParser(['application/pdf', 'image/png', 'image/jpeg'], { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body))
  await app.register(fastifyCookie)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: config.swaggerEnabled
      ? { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'validator.swagger.io'], scriptSrc: ["'self'", "'unsafe-inline'"] } }
      : undefined,
  })
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id', 'X-Client-Version', 'Accept'],
    exposedHeaders: ['X-Correlation-Id', 'Idempotent-Replayed'],
    maxAge: 600,
  })
  app.setGlobalPrefix(config.apiPrefix)
  app.enableShutdownHooks()
  if (config.swaggerEnabled) setupSwagger(app, config)
}

export function setupSwagger(app: INestApplication, config: AppConfig) {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Sistema de Gestión de Transportes — API')
      .setDescription(
        'DOC-E-BE · Contratos API definitivos (REST /api/v1). Errores application/problem+json (ADR-013). ' +
          'Autorización por permiso + alcance + política; el tenant se resuelve SIEMPRE desde la sesión.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  )
  SwaggerModule.setup(`${config.apiPrefix.split('/')[0]}/docs`, app, doc, { jsonDocumentUrl: `${config.apiPrefix.split('/')[0]}/openapi.json` })
  return doc
}
