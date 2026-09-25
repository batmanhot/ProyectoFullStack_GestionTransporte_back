import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'

/**
 * Puerto de almacenamiento de objetos (ADR-009: storage abstracto). El proveedor final (S3 compatible, Azure Blob, GCS…)
 * lo decide DOC-I-OPS; basta con otra implementación de este puerto. La API nunca entrega credenciales del almacenamiento:
 * solo URLs TEMPORALES firmadas para subir o descargar un objeto concreto.
 */
export abstract class ObjectStorage {
  abstract uploadUrl(key: string, contentType: string, size: number, ttlSeconds: number): string
  abstract downloadUrl(key: string, name: string, contentType: string, ttlSeconds: number): string
  abstract exists(key: string): Promise<{ size: number } | null>
  abstract head(key: string, bytes: number): Promise<Buffer>
}

export interface SignedClaims {
  k: string
  op: 'put' | 'get'
  exp: number
  t: string
  s?: number
  n?: string
}

/**
 * Adaptador LOCAL (solo desarrollo/pruebas): guarda en disco y emula URLs pre-firmadas con HMAC servidas por la propia API
 * (`/files/blob/:token`). En producción debe reemplazarse por un almacenamiento gestionado con cifrado en reposo.
 */
@Injectable()
export class LocalObjectStorage extends ObjectStorage {
  private readonly root: string
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super()
    this.root = resolve(config.storage.localDir)
  }

  private sign(c: SignedClaims): string {
    const body = Buffer.from(JSON.stringify(c)).toString('base64url')
    const mac = createHmac('sha256', this.config.storage.signingSecret).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  verify(token: string, op: SignedClaims['op']): SignedClaims | null {
    const [body, mac] = token.split('.')
    if (!body || !mac) return null
    const expected = createHmac('sha256', this.config.storage.signingSecret).update(body).digest()
    const given = Buffer.from(mac, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    try {
      const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedClaims
      return c.op === op && c.exp > Date.now() ? c : null
    } catch {
      return null
    }
  }

  /** Ruta física confinada a la raíz (evita path traversal con claves manipuladas). */
  path(key: string): string {
    const p = resolve(join(this.root, key))
    if (!p.startsWith(this.root + sep)) throw new Error('Clave de almacenamiento inválida')
    return p
  }

  private url(token: string) {
    return `${this.config.storage.publicBaseUrl}/${this.config.apiPrefix}/files/blob/${token}`
  }

  uploadUrl(key: string, contentType: string, size: number, ttlSeconds: number): string {
    return this.url(this.sign({ k: key, op: 'put', exp: Date.now() + ttlSeconds * 1000, t: contentType, s: size }))
  }

  downloadUrl(key: string, name: string, contentType: string, ttlSeconds: number): string {
    return this.url(this.sign({ k: key, op: 'get', exp: Date.now() + ttlSeconds * 1000, t: contentType, n: name }))
  }

  async write(key: string, data: Buffer): Promise<void> {
    const p = this.path(key)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, data, { flag: 'wx' }) // una clave se escribe una sola vez
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async exists(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.path(key))
      return { size: s.size }
    } catch {
      return null
    }
  }

  async head(key: string, bytes: number): Promise<Buffer> {
    return (await this.read(key)).subarray(0, bytes)
  }
}
