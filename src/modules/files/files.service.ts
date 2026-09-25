import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { StoredFile } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { clean } from '../../common/http/params'
import { PrismaService } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'
import { LocalObjectStorage } from './object-storage'

export const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const
export const FILE_MAX_BYTES = 5 * 1024 * 1024
const UPLOAD_TTL_S = 10 * 60
const DOWNLOAD_TTL_S = 5 * 60

/** Firma binaria esperada por tipo: el contenido debe ser lo que declara (no basta con el Content-Type). */
export function matchesSignature(type: string, head: Buffer): boolean {
  if (type === 'application/pdf') return head.subarray(0, 5).toString('latin1') === '%PDF-'
  if (type === 'image/png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (type === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  return false
}

/** Nombre visible seguro: sin separadores de ruta ni caracteres de control (evita inyección en cabeceras y rutas). */
export const safeFileName = (name: string) =>
  [...clean(name)].map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 120) || 'archivo'

export const fileView =(f: StoredFile) => ({ id: f.id, name: f.name, size: f.size, type: f.type, uploadedAt: (f.completedAt ?? f.createdAt).toISOString() })

/**
 * Archivos (ADR-009 · FE-CONTRACT-030): 1) POST /files reserva y devuelve URL temporal de subida; 2) el cliente sube DIRECTO
 * al almacenamiento (sin token de la API); 3) POST /files/{id}/complete verifica tamaño y firma binaria y lo deja disponible.
 * Descarga con URL temporal auditada. Aislado por tenant; PDF/JPG/PNG ≤ 5 MB validado en servidor.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalObjectStorage,
    private readonly audit: AuditService,
  ) {}

  async reserve(p: Principal, i: { name: string; size: number; type: string }) {
    const errs = new FieldErrors()
    errs.when(!(FILE_TYPES as readonly string[]).includes(i.type), 'file', 'Formato no permitido: use PDF, JPG o PNG.')
    errs.when(i.size <= 0, 'file', 'El archivo está vacío.')
    errs.when(i.size > FILE_MAX_BYTES, 'file', `El archivo pesa ${(i.size / 1048576).toFixed(1)} MB: el máximo es 5 MB.`)
    errs.throwIfAny()
    const tenantId = p.tenantId as string
    const f = await this.prisma.db.storedFile.create({
      data: { tenantId, name: safeFileName(i.name), size: i.size, type: i.type, storageKey: `pending-${randomUUID()}`, uploadedBy: p.userId },
    })
    const key = `${tenantId}/${f.id}`
    await this.prisma.db.storedFile.update({ where: { id: f.id }, data: { storageKey: key } })
    return { fileId: f.id, uploadUrl: this.storage.uploadUrl(key, i.type, i.size, UPLOAD_TTL_S), headers: {} as Record<string, string>, expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000).toISOString() }
  }

  /** Recepción del binario (emula el PUT directo al almacenamiento). La autorización es el token firmado. */
  async receiveBlob(token: string, contentType: string | undefined, body: unknown) {
    const c = this.storage.verify(token, 'put')
    if (!c) throw Errors.forbidden('La URL de subida no es válida o expiró.')
    if (!Buffer.isBuffer(body)) throw Errors.field('file', 'Cuerpo de archivo inválido.')
    if ((contentType ?? '').split(';')[0] !== c.t) throw Errors.field('file', 'El tipo del archivo no coincide con el declarado.')
    if (body.length !== c.s) throw Errors.field('file', 'El tamaño del archivo no coincide con el declarado.')
    if (!matchesSignature(c.t, body)) throw Errors.field('file', 'El contenido no corresponde a un PDF/JPG/PNG válido.')
    try {
      await this.storage.write(c.k, body)
    } catch {
      throw Errors.conflict('Archivo ya recibido', 'Este archivo ya fue subido.')
    }
  }

  async complete(p: Principal, id: string) {
    const f = await this.prisma.db.storedFile.findFirst({ where: { id, uploadedBy: p.userId } })
    if (!f) throw Errors.unavailable()
    if (f.status === 'DISPONIBLE') return fileView(f)
    const obj = await this.storage.exists(f.storageKey)
    if (!obj || obj.size !== f.size) throw Errors.conflict('Subida incompleta', 'El archivo no llegó completo al almacenamiento. Vuelva a subirlo.')
    if (!matchesSignature(f.type, await this.storage.head(f.storageKey, 16))) throw Errors.field('file', 'El contenido no corresponde al tipo declarado.')
    const next = await this.prisma.db.storedFile.update({ where: { id }, data: { status: 'DISPONIBLE', completedAt: new Date() } })
    await this.audit.record({ resourceType: 'Archivo', resourceId: f.name, action: 'file.upload', after: `${f.type} · ${Math.max(1, Math.round(f.size / 1024))} KB` })
    return fileView(next)
  }

  async downloadUrl(_p: Principal, id: string) {
    const f = await this.prisma.db.storedFile.findFirst({ where: { id, status: 'DISPONIBLE' } })
    if (!f) throw Errors.unavailable()
    await this.audit.record({ resourceType: 'Archivo', resourceId: f.name, action: 'file.download', after: f.type })
    return { url: this.storage.downloadUrl(f.storageKey, f.name, f.type, DOWNLOAD_TTL_S), name: f.name, type: f.type, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() }
  }

  async serveBlob(token: string) {
    const c = this.storage.verify(token, 'get')
    if (!c) throw Errors.forbidden('La URL de descarga no es válida o expiró.')
    return { data: await this.storage.read(c.k), type: c.t, name: c.n ?? 'archivo' }
  }
}
