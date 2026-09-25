import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { OnEvent } from '@nestjs/event-emitter'
import { WebSocket, WebSocketServer } from 'ws'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'
import { RequestContext } from '../../common/context/request-context'
import type { Principal } from '../access/domain/principal'
import { DataScope } from '../access/domain/scope'
import { PrincipalLoader } from '../auth/principal.loader'
import { TokenService } from '../auth/token.service'
import { REALTIME_CHANNEL, type RealtimeEnvelope } from './realtime.publisher'

interface Conn {
  ws: WebSocket
  principal: Principal
  scope: DataScope
  exp: number
  familyId: string
}

const REVALIDATE_MS = 60_000
const PING_MS = 30_000

/** Decide si una conexión debe recibir el evento (tenant + audiencia). Exportada para pruebas. */
export function shouldDeliver(c: { principal: Principal; scope: DataScope }, env: RealtimeEnvelope): boolean {
  if (c.principal.tenantId !== env.tenantId) return false
  if (c.principal.permissions.every((p) => p === 'passenger.portal')) return false
  const a = env.audience
  if (a.driverUserId && a.driverUserId === c.principal.userId) return true
  if (a.anyPerm?.length && !a.anyPerm.some((p) => c.principal.permissions.includes(p))) return false
  if (c.scope.isDriver) return false // el conductor solo recibe lo propio (driverUserId)
  if (a.baseId && !c.scope.covers(a.baseId)) return false
  return true
}

/**
 * Canal en tiempo real (ADR-007 · FE-CONTRACT-013). WebSocket autenticado y SCOPED; solo notifica — el cliente reconcilia por REST.
 * Autenticación: subprotocolo `bearer, <access token>` (lo que implementa el FE; el token no viaja en la URL ⇒ no queda en logs).
 * PROPUESTA C.2-1 de DOC-D-FE: se adopta el subprotocolo; el ticket efímero queda como alternativa para DOC-G-SEC.
 * Nunca acepta comandos por el canal (los mensajes entrantes se ignoran).
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Realtime')
  private wss: WebSocketServer | null = null
  private readonly conns = new Set<Conn>()
  private timers: NodeJS.Timeout[] = []

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalLoader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get path(): string {
    return `/${this.config.apiPrefix}/realtime`
  }

  connectionsByTenant(): Map<string, number> {
    const m = new Map<string, number>()
    for (const c of this.conns) if (c.principal.tenantId) m.set(c.principal.tenantId, (m.get(c.principal.tenantId) ?? 0) + 1)
    return m
  }

  get total(): number {
    return this.conns.size
  }

  onApplicationBootstrap(): void {
    const server = this.adapter.httpAdapter?.getHttpServer() as import('node:http').Server | undefined
    if (!server) return
    this.wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false) })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = (req.url ?? '').split('?')[0]
      if (url !== this.path) return
      void this.upgrade(req, socket, head)
    })
    this.log.log(`Canal en tiempo real disponible en ${this.path} (subprotocolo bearer)`)
    this.timers.push(setInterval(() => void this.revalidate(), REVALIDATE_MS))
    this.timers.push(setInterval(() => this.conns.forEach((c) => c.ws.readyState === WebSocket.OPEN && c.ws.ping()), PING_MS))
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval)
    this.conns.forEach((c) => c.ws.close(1001, 'server shutdown'))
    this.wss?.close()
  }

  private reject(socket: Duplex, status: number) {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin
    if (origin && !this.config.corsOrigins.includes(origin)) return this.reject(socket, 403)
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    const token = protocols[0] === 'bearer' ? protocols[1] : undefined
    if (!token) return this.reject(socket, 401)
    try {
      const claims = await this.tokens.verifyAccess(token)
      const principal = await RequestContext.run({ correlationId: 'ws-upgrade', ip: req.socket.remoteAddress ?? null, userAgent: null, principal: null, tenantId: null }, () => this.principals.load(claims.sub, claims.sid))
      // La plataforma SÍ puede conectarse (FE-071 `PlatformMonitorPage` abre este canal para mostrar el badge de conexión en vivo),
      // pero SOD-003 se preserva en `shouldDeliver`: sin tenant propio, ningún evento de negocio hace match y nunca se le entrega nada.
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const conn: Conn = { ws, principal, scope: new DataScope(principal), exp: claims.exp * 1000, familyId: claims.sid }
        this.conns.add(conn)
        const expiry = setTimeout(() => ws.close(4001, 'token expired'), Math.max(1000, conn.exp - Date.now()))
        ws.on('message', () => undefined) // sin comandos por WebSocket (ADR-007)
        ws.on('close', () => {
          clearTimeout(expiry)
          this.conns.delete(conn)
        })
      })
    } catch {
      this.reject(socket, 401)
    }
  }

  /** Revocación/suspensión aplican también a conexiones abiertas. */
  private async revalidate() {
    for (const c of [...this.conns]) {
      try {
        c.principal = await RequestContext.run({ correlationId: 'ws-revalidate', ip: null, userAgent: null, principal: null, tenantId: null }, () => this.principals.load(c.principal.userId, c.familyId))
        c.scope = new DataScope(c.principal)
      } catch {
        c.ws.close(4003, 'session revoked')
      }
    }
  }

  @OnEvent(REALTIME_CHANNEL)
  deliver(env: RealtimeEnvelope): void {
    const payload = JSON.stringify(env.event)
    for (const c of this.conns) {
      if (c.ws.readyState === WebSocket.OPEN && shouldDeliver(c, env)) c.ws.send(payload)
    }
  }
}
