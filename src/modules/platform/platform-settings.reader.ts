import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'

const TTL_MS = 30_000

/** Lectura cacheada de los ajustes globales (se consultan en cada petición autenticada por la política de gracia). */
@Injectable()
export class PlatformSettingsReader {
  private cache: { at: number; value: { graceDays: number; quickAccessCardsEnabled: boolean } } | null = null

  constructor(private readonly prisma: PrismaService) {}

  invalidate(): void {
    this.cache = null
  }

  async get(): Promise<{ graceDays: number; quickAccessCardsEnabled: boolean }> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value
    const row = await this.prisma.system.platformSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
    const value = { graceDays: row.graceDays, quickAccessCardsEnabled: row.quickAccessCardsEnabled }
    this.cache = { at: Date.now(), value }
    return value
  }

  async graceDays(): Promise<number> {
    return (await this.get()).graceDays
  }
}
