import { LOAN_EVENT_PAYLOAD_SCHEMA, isWritableLoanEventType } from './loan-event.types'

describe('LOAN_EVENT_PAYLOAD_SCHEMA (Stage 10, T4)', () => {
  it('описує лише типи, які реально пише 10d', () => {
    expect(Object.keys(LOAN_EVENT_PAYLOAD_SCHEMA).sort()).toEqual(['LOAN_LOST', 'RECOVERED'])
    expect(isWritableLoanEventType('RECOVERED')).toBe(true)
    expect(isWritableLoanEventType('RECORD_PROPOSED')).toBe(false)
  })

  it.each(['LOAN_LOST', 'RECOVERED'] as const)('%s: порожній payload проходить', (type) => {
    expect(LOAN_EVENT_PAYLOAD_SCHEMA[type].safeParse({}).success).toBe(true)
  })

  it.each(['LOAN_LOST', 'RECOVERED'] as const)(
    '%s: strict — жодного alias, email, contactId чи вільного тексту',
    (type) => {
      for (const extra of [
        { alias: 'Іра' },
        { email: 'x@example.com' },
        { contactId: 'c-1' },
        { note: 'знайшла під диваном' },
        { effectiveAt: '2026-09-20' },
      ]) {
        expect(LOAN_EVENT_PAYLOAD_SCHEMA[type].safeParse(extra).success).toBe(false)
      }
    },
  )
})
