import { Injectable } from '@nestjs/common'

export interface RequestSample {
  at: number
  method: string
  /** Plantilla de ruta (p. ej. /api/v1/trips/:id): nunca la URL real, que podría contener identificadores o datos. */
  route: string
  status: number
  latencyMs: number
  tenantId: string | null
  userId: string | null
}

const WINDOW_MS = 5 * 60_000
const MAX_SAMPLES = 50_000

/**
 * Señales técnicas para la consola de plataforma (prompt §19 · ADR-012). Ventana deslizante en memoria por réplica.
 * No se elige todavía Prometheus/Datadog (decisión de DOC-I-OPS): este servicio es el punto único para exportarlas luego.
 */
@Injectable()
export class MetricsService {
  private samples: RequestSample[] = []
  readonly startedAt = Date.now()

  record(s: RequestSample): void {
    this.samples.push(s)
    if (this.samples.length > MAX_SAMPLES) this.samples = this.samples.slice(-MAX_SAMPLES / 2)
  }

  window(ms = WINDOW_MS): RequestSample[] {
    const from = Date.now() - ms
    this.samples = this.samples.filter((x) => x.at >= Date.now() - WINDOW_MS)
    return this.samples.filter((x) => x.at >= from)
  }

  summary() {
    const last = this.window(60_000)
    const all = this.window()
    const lat = last.map((x) => x.latencyMs).sort((a, b) => a - b)
    const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]! : 0
    const errors = last.filter((x) => x.status >= 500).length
    return {
      requestsPerMinute: last.length,
      averageLatencyMs: lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : 0,
      p95LatencyMs: Math.round(p95),
      errorRatePct: last.length ? Math.round((errors / last.length) * 1000) / 10 : 0,
      activeUsersLast5m: new Set(all.map((x) => x.userId).filter(Boolean)).size,
      requestTrend: [60, 50, 40, 30, 20, 10, 0].map((sec) => ({ label: `T-${sec}s`, requests: all.filter((x) => x.at <= Date.now() - sec * 1000 && x.at > Date.now() - (sec + 10) * 1000).length })),
      recent: all.slice(-5).reverse(),
    }
  }

  tenantErrorRate(tenantId: string): number {
    const t = this.window().filter((x) => x.tenantId === tenantId)
    return t.length ? Math.round((t.filter((x) => x.status >= 500).length / t.length) * 1000) / 10 : 0
  }
}
