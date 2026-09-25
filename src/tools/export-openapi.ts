/**
 * Exporta el contrato OpenAPI 3 (DOC-E-BE §F) a docs/openapi.json sin conectarse a la BD ni abrir puertos:
 * se construye el grafo de módulos y se leen los metadatos de controladores/DTOs.
 * Uso: npm run openapi (compila y ejecuta desde dist/: Nest necesita los metadatos de decoradores que emite tsc).
 */
import 'reflect-metadata'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from '../app.module'
import { createAdapter, setupSwagger } from '../bootstrap'
import { APP_CONFIG, type AppConfig } from '../config/app-config'

async function main() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), { logger: false, bodyParser: false, abortOnError: false })
  const config = app.get<AppConfig>(APP_CONFIG)
  app.setGlobalPrefix(config.apiPrefix)
  const doc = setupSwagger(app, config)
  const out = join(process.cwd(), 'docs', 'openapi.json')
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`OpenAPI exportado: ${out} (${Object.keys(doc.paths).length} rutas)`)
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
