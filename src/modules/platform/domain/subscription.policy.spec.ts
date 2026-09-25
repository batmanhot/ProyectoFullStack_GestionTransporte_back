import { subscriptionNotice, subscriptionPhase } from './subscription.policy'

const END = Date.parse('2026-10-01T12:00:00Z')
const DAY = 86_400_000

describe('Vigencia comercial y gracia (PC-A1 Fase 4 · prompt §16)', () => {
  it('ACTIVA → POR VENCER → EN GRACIA → BLOQUEADA con N días de gracia', () => {
    const end = new Date(END)
    expect(subscriptionPhase(end, 5, END - 10 * DAY)).toBe('Activa')
    expect(subscriptionPhase(end, 5, END - 3 * DAY)).toBe('Por vencer')
    expect(subscriptionPhase(end, 5, END + 1 * DAY)).toBe('En gracia')
    expect(subscriptionPhase(end, 5, END + 5 * DAY)).toBe('Bloqueada')
  })

  it('con 0 días de gracia el bloqueo es inmediato al vencer y no hay aviso previo', () => {
    const end = new Date(END)
    expect(subscriptionPhase(end, 0, END - DAY)).toBe('Activa')
    expect(subscriptionPhase(end, 0, END)).toBe('Bloqueada')
  })

  it('el aviso informa hasta cuándo hay acceso y nunca aparece si está activa', () => {
    const n = subscriptionNotice({ plan: 'Business', endsAt: new Date(END) }, 'Andina', 5, END + DAY)
    expect(n).toMatchObject({ status: 'En gracia', plan: 'Business', graceDays: 5 })
    expect(n!.accessUntil).toBe(new Date(END + 5 * DAY).toISOString())
    expect(subscriptionNotice({ plan: 'Business', endsAt: new Date(END) }, 'Andina', 5, END - 30 * DAY)).toBeNull()
  })
})
