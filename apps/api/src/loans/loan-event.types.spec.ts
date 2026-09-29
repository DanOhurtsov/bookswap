import { LOAN_EVENT_PAYLOAD_SCHEMA, isWritableLoanEventType } from './loan-event.types'

describe('LOAN_EVENT_PAYLOAD_SCHEMA (Stage 10, T4)', () => {
  it('описує лише типи, які реально пишуть 10d–10i.1', () => {
    expect(Object.keys(LOAN_EVENT_PAYLOAD_SCHEMA).sort()).toEqual([
      'GUEST_CONFIRMATION_REQUESTED',
      'GUEST_HANDOVER_CANCELLED',
      'GUEST_LOAN_OWNER_RECORDED',
      'GUEST_LOAN_RECORDED',
      'LOAN_LOST',
      'LOAN_RETURNED',
      'LOSS_CLOSED',
      'RECORD_AMENDED',
      'RECORD_CONFIRMED',
      'RECORD_DECLINED',
      'RECORD_PROPOSED',
      'RECORD_WITHDRAWN',
      'RECOVERED',
    ])
    expect(isWritableLoanEventType('RECOVERED')).toBe(true)
    expect(isWritableLoanEventType('RECORD_PROPOSED')).toBe(true)
    expect(isWritableLoanEventType('GUEST_LOAN_RECORDED')).toBe(true)
    expect(isWritableLoanEventType('LOSS_CLOSED')).toBe(true)
  })

  it('RECORD_PROPOSED/AMENDED: strict-схеми з датами; зайві поля й вільний текст відхиляються', () => {
    const dates = { handedOn: '2026-05-01', dueOn: null }

    expect(LOAN_EVENT_PAYLOAD_SCHEMA.RECORD_PROPOSED.safeParse(dates).success).toBe(true)
    expect(
      LOAN_EVENT_PAYLOAD_SCHEMA.RECORD_PROPOSED.safeParse({ ...dates, note: 'x' }).success,
    ).toBe(false)
    expect(
      LOAN_EVENT_PAYLOAD_SCHEMA.RECORD_PROPOSED.safeParse({ handedOn: 'вчора', dueOn: null })
        .success,
    ).toBe(false)
    expect(
      LOAN_EVENT_PAYLOAD_SCHEMA.RECORD_AMENDED.safeParse({
        previous: dates,
        next: { handedOn: '2026-05-02', dueOn: '2026-06-01' },
      }).success,
    ).toBe(true)
    expect(LOAN_EVENT_PAYLOAD_SCHEMA.RECORD_AMENDED.safeParse({ previous: dates }).success).toBe(
      false,
    )
  })

  it.each([
    'LOAN_LOST',
    'RECOVERED',
    'LOAN_RETURNED',
    'RECORD_CONFIRMED',
    'RECORD_DECLINED',
    'RECORD_WITHDRAWN',
    'GUEST_LOAN_RECORDED',
    'LOSS_CLOSED',
    'GUEST_CONFIRMATION_REQUESTED',
    'GUEST_HANDOVER_CANCELLED',
    'GUEST_LOAN_OWNER_RECORDED',
  ] as const)('%s: порожній payload проходить', (type) => {
    expect(LOAN_EVENT_PAYLOAD_SCHEMA[type].safeParse({}).success).toBe(true)
  })

  it.each([
    'LOAN_LOST',
    'RECOVERED',
    'LOAN_RETURNED',
    'RECORD_CONFIRMED',
    'RECORD_DECLINED',
    'RECORD_WITHDRAWN',
    'GUEST_LOAN_RECORDED',
    'LOSS_CLOSED',
    'GUEST_CONFIRMATION_REQUESTED',
    'GUEST_HANDOVER_CANCELLED',
    'GUEST_LOAN_OWNER_RECORDED',
  ] as const)('%s: strict — жодного alias, email, contactId чи вільного тексту', (type) => {
    for (const extra of [
      { alias: 'Іра' },
      { email: 'x@example.com' },
      { contactId: 'c-1' },
      { note: 'знайшла під диваном' },
      { effectiveAt: '2026-09-20' },
    ]) {
      expect(LOAN_EVENT_PAYLOAD_SCHEMA[type].safeParse(extra).success).toBe(false)
    }
  })
})
