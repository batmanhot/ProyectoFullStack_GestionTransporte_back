import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Prisma 7: la URL de conexión vive aquí (no en schema.prisma). Solo la usan migrate/seed/studio (rol dueño: MIGRATE_DATABASE_URL);
 * la aplicación se conecta con el adaptador `@prisma/adapter-pg` (ver src/database/prisma.service.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Migrar y sembrar exige el DUEÑO de las tablas (no el rol de ejecución transportes_app, que está sujeto a RLS).
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/transportes?schema=public',
  },
})
