import { Injectable } from '@nestjs/common'
import type { CatalogItem, CatalogKind, ClientDocumentType } from '../../generated/prisma/client'
import { Errors, FieldErrors } from '../../common/errors/app-error'
import { CATALOG_KIND } from '../../common/labels'
import { clean } from '../../common/http/params'
import { PrismaService, type Tx } from '../../database/prisma.service'
import type { Principal } from '../access/domain/principal'
import { AuditService } from '../audit/audit.service'

export const catalogView = (c: CatalogItem) => ({
  id: c.id,
  kind: CATALOG_KIND.label(c.kind),
  label: c.label,
  hint: c.hint,
  active: c.active,
  createdBy: c.createdBy,
  createdAt: c.createdAt.toISOString(),
  version: c.version,
})

/** RUC: empresa (11 dígitos). DNI: persona natural (8 dígitos). Formato peruano declarado por el negocio en DOC-D-FE (PC-A18). */
export function clientDocumentProblem(type: ClientDocumentType, document: string | null | undefined): string | null {
  const d = clean(document)
  if (type === 'RUC') return /^\d{11}$/.test(d) ? null : 'El RUC debe tener 11 dígitos.'
  return /^\d{8}$/.test(d) ? null : 'El DNI debe tener 8 dígitos.'
}
export const normalizeDoc = (d: string) => d.trim().toUpperCase()

/**
 * Maestros compartidos del negocio:
 *  - Catálogos editables (PC-A19): tipos de carga y de servicio. Nunca se borran: se dan de baja (siguen en registros previos).
 *  - Maestro de clientes por documento (PC-A18): un documento nunca queda con dos razones sociales distintas.
 */
@Injectable()
export class MastersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listCatalog(kindLabel: string) {
    const kind = CATALOG_KIND.parse(kindLabel)
    if (!kind) throw Errors.field('kind', 'Catálogo desconocido (cargoType | serviceType).')
    const rows = await this.prisma.db.catalogItem.findMany({ where: { kind }, orderBy: { label: 'asc' } })
    return rows.map(catalogView)
  }

  private async assertUniqueLabel(tx: Tx, kind: CatalogKind, label: string, exceptId?: string) {
    const errs = new FieldErrors()
    errs.when(clean(label).length < 2, 'label', 'Indique el nombre (mín. 2 caracteres).')
    errs.throwIfAny()
    const dup = await tx.catalogItem.findFirst({ where: { kind, labelKey: clean(label).toLowerCase(), ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } })
    if (dup) throw Errors.field('label', `Ya existe «${clean(label)}» en este catálogo.`)
  }

  async createCatalog(p: Principal, input: { kind: string; label: string; hint: string }) {
    const kind = CATALOG_KIND.parse(input.kind)
    if (!kind) throw Errors.field('kind', 'Catálogo desconocido.')
    return this.prisma.tx(async (tx) => {
      await this.assertUniqueLabel(tx, kind, input.label)
      const c = await tx.catalogItem.create({ data: { tenantId: p.tenantId as string, kind, label: clean(input.label), labelKey: clean(input.label).toLowerCase(), hint: clean(input.hint), createdBy: p.name } })
      await this.audit.record({ resourceType: 'Catálogo', resourceId: c.label, action: 'catalog.create', after: `${input.kind} · ${c.label}` }, tx)
      return catalogView(c)
    })
  }

  async updateCatalog(id: string, input: { label: string; hint: string }) {
    return this.prisma.tx(async (tx) => {
      const c = await tx.catalogItem.findFirst({ where: { id } })
      if (!c) throw Errors.unavailable()
      await this.assertUniqueLabel(tx, c.kind, input.label, c.id)
      const next = await tx.catalogItem.update({ where: { id }, data: { label: clean(input.label), labelKey: clean(input.label).toLowerCase(), hint: clean(input.hint), version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Catálogo', resourceId: next.label, action: 'catalog.update', before: c.label, after: next.label }, tx)
      return catalogView(next)
    })
  }

  async setCatalogActive(id: string, active: boolean) {
    return this.prisma.tx(async (tx) => {
      const c = await tx.catalogItem.findFirst({ where: { id } })
      if (!c) throw Errors.unavailable()
      const next = await tx.catalogItem.update({ where: { id }, data: { active, version: { increment: 1 } } })
      await this.audit.record({ resourceType: 'Catálogo', resourceId: c.label, action: active ? 'catalog.activate' : 'catalog.deactivate', after: active ? 'Activo' : 'Inactivo' }, tx)
      return catalogView(next)
    })
  }

  /** El valor debe ser un ítem ACTIVO del catálogo del negocio (evita textos sueltos que no existen en ningún selector). */
  async isActiveLabel(tx: Tx, kind: CatalogKind, label: string): Promise<boolean> {
    return !!(await tx.catalogItem.findFirst({ where: { kind, label: clean(label), active: true }, select: { id: true } }))
  }

  async lookupClient(documentType: string, document: string) {
    if (documentType !== 'RUC' && documentType !== 'DNI') throw Errors.field('documentType', 'Tipo de documento inválido.')
    const c = await this.prisma.db.clientProfile.findFirst({ where: { documentType, document: normalizeDoc(document) } })
    if (!c) throw Errors.notFound('El documento aún no está registrado.')
    return { documentType: c.documentType, document: c.document, customer: c.customer }
  }

  async upsertClient(tx: Tx, tenantId: string, documentType: ClientDocumentType, document: string, customer: string) {
    const doc = normalizeDoc(document)
    await tx.clientProfile.upsert({
      where: { tenantId_documentType_document: { tenantId, documentType, document: doc } },
      create: { tenantId, documentType, document: doc, customer: clean(customer) },
      update: { customer: clean(customer) },
    })
  }
}
