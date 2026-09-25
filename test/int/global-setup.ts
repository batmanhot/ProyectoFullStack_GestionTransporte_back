import { execSync } from 'node:child_process'

/**
 * Deja la BD de PRUEBA en un estado conocido: borra todo, aplica las migraciones y carga la semilla DEMO.
 * Salvaguardas:
 *  - solo resetea una base cuyo nombre termine en `_test` (o con ALLOW_DB_RESET=true): nunca una BD de trabajo por accidente;
 *  - con DB_PREPARED=true NO resetea (la BD ya viene migrada y sembrada, p. ej. una base nueva creada por el pipeline de CI).
 */
export default function globalSetup(): void {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('Las pruebas de integración requieren DATABASE_URL (BD de prueba desechable).')
  if (process.env.DB_PREPARED === 'true') return
  const dbName = new URL(url).pathname.replace('/', '')
  if (!dbName.endsWith('_test') && process.env.ALLOW_DB_RESET !== 'true') {
    throw new Error(`Por seguridad solo se resetea una BD cuyo nombre termine en _test (recibido: ${dbName}).`)
  }
  const env = { ...process.env, NODE_ENV: 'test', PRISMA_HIDE_UPDATE_MESSAGE: '1' }
  execSync('npx prisma migrate reset --force', { stdio: 'inherit', env })
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', env })
}
