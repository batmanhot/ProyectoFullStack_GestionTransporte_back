import 'reflect-metadata'
import 'dotenv/config'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module'
import { configureApp, createAdapter } from './bootstrap'
import { APP_CONFIG, type AppConfig } from './config/app-config'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), { bufferLogs: false, bodyParser: false })
  const config = app.get<AppConfig>(APP_CONFIG)
  await configureApp(app, config)
  await app.listen({ port: config.port, host: '0.0.0.0' })
  new Logger('Bootstrap').log(`API escuchando en :${config.port}/${config.apiPrefix} (${config.env})`)
}

bootstrap().catch((e: unknown) => {
  // Startup checks (§Y): configuración inválida o BD inaccesible detienen el arranque con un mensaje claro.
  new Logger('Bootstrap').error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
