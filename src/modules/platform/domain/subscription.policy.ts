/**
 * Política de vigencia comercial (PC-A1 Fase 4 · prompt §16). Función pura: la usan autenticación, autorización,
 * aviso al negocio y Centro de alertas, para que todos apliquen EXACTAMENTE la misma regla.
 *
 *   ACTIVA ──(últimos N días)──► POR VENCER ──(endsAt)──► EN GRACIA (N días, con acceso) ──(endsAt + N)──► BLOQUEADA
 *   N = graceDays (0–60, Ajustes de plataforma). Con N = 0 el bloqueo es inmediato al vencer.
 *   REACTIVADA = renovar reemplaza la vigencia; el acceso vuelve sin tocar datos (nunca se borran datos por vencimiento).
 */
export type SubscriptionPhase = 'Activa' | 'Por vencer' | 'En gracia' | 'Bloqueada'

export interface SubscriptionNotice {
  status: 'Por vencer' | 'En gracia' | 'Bloqueada'
  tenantName: string
  plan: string
  endsAt: string
  accessUntil: string
  graceDays: number
}

const DAY_MS = 86_400_000

export function subscriptionPhase(endsAt: Date, graceDays: number, now = Date.now()): SubscriptionPhase {
  const end = endsAt.getTime()
  const accessUntil = end + graceDays * DAY_MS
  if (now >= accessUntil) return 'Bloqueada'
  if (now >= end) return 'En gracia'
  if (graceDays > 0 && end - now <= graceDays * DAY_MS) return 'Por vencer'
  return 'Activa'
}

export function subscriptionNotice(
  sub: { plan: string; endsAt: Date },
  tenantName: string,
  graceDays: number,
  now = Date.now(),
): SubscriptionNotice | null {
  const phase = subscriptionPhase(sub.endsAt, graceDays, now)
  if (phase === 'Activa') return null
  return {
    status: phase,
    tenantName,
    plan: sub.plan,
    endsAt: sub.endsAt.toISOString(),
    accessUntil: new Date(sub.endsAt.getTime() + graceDays * DAY_MS).toISOString(),
    graceDays,
  }
}

/** Mensaje del bloqueo por vencimiento: explica y tranquiliza (los datos se conservan). */
export const blockedDetail = (n: SubscriptionNotice) =>
  `La suscripción de "${n.tenantName}" venció el ${n.endsAt.slice(0, 10)} y terminó su período de gracia. Sus datos se conservan; contacte a su administrador o soporte para regularizar el servicio.`

/** Negocio operable: solo Activo o Reactivado (EXC-002: suspendido ⇒ sin acceso, datos conservados). */
export const OPERABLE_LIFECYCLES = ['ACTIVO', 'REACTIVADO'] as const
