import {
  EXTERNAL_BORROWER_LIMITS,
  createExternalBorrowerRequestSchema,
  externalBorrowerListResponseSchema,
  externalBorrowerSchema,
  updateExternalBorrowerRequestSchema,
} from './external-borrower'

describe('createExternalBorrowerRequestSchema', () => {
  it('приймає alias і заяву власника, обрізаючи пробіли', () => {
    expect(
      createExternalBorrowerRequestSchema.parse({
        alias: '  Тестовий Гість  ',
        ownerInformed: true,
      }),
    ).toEqual({ alias: 'Тестовий Гість', ownerInformed: true })
  })

  it.each([
    ['порожній alias', { alias: '', ownerInformed: true }],
    ['alias із самих пробілів', { alias: '   ', ownerInformed: true }],
    [
      'надто довгий alias',
      { alias: 'x'.repeat(EXTERNAL_BORROWER_LIMITS.aliasMax + 1), ownerInformed: true },
    ],
    ['без alias', { ownerInformed: true }],
    ['ownerInformed=false', { alias: 'Гість', ownerInformed: false }],
    ['без ownerInformed', { alias: 'Гість' }],
    ['ownerInformed рядком', { alias: 'Гість', ownerInformed: 'true' }],
  ])('відхиляє: %s', (_name, payload) => {
    expect(createExternalBorrowerRequestSchema.safeParse(payload).success).toBe(false)
  })

  it.each(['ownerId', 'ownerInformedAt', 'retainUntil', 'email', 'note', 'linkedUserId', 'id'])(
    'відхиляє зайве поле %s',
    (field) => {
      expect(
        createExternalBorrowerRequestSchema.safeParse({
          alias: 'Гість',
          ownerInformed: true,
          [field]: 'x',
        }).success,
      ).toBe(false)
    },
  )
})

describe('updateExternalBorrowerRequestSchema', () => {
  it('змінює лише alias', () => {
    expect(updateExternalBorrowerRequestSchema.parse({ alias: ' Нове ' })).toEqual({
      alias: 'Нове',
    })
  })

  it.each([
    {},
    { alias: '' },
    { alias: 'Гість', ownerInformed: true },
    { alias: 'Гість', ownerInformedAt: '2026-01-01T00:00:00.000Z' },
    { alias: 'Гість', retainUntil: null },
    { alias: 'Гість', ownerId: 'u-1' },
    { alias: 'Гість', email: 'a@b.c' },
  ])('відхиляє %j', (payload) => {
    expect(updateExternalBorrowerRequestSchema.safeParse(payload).success).toBe(false)
  })
})

describe('відповіді', () => {
  const contact = {
    id: 'c-1',
    alias: 'Гість',
    ownerInformedAt: '2026-09-27T10:00:00.000Z',
    createdAt: '2026-09-27T10:00:00.000Z',
  }

  it('контакт не має ownerId і retainUntil', () => {
    expect(externalBorrowerSchema.safeParse(contact).success).toBe(true)
    expect(externalBorrowerSchema.safeParse({ ...contact, ownerId: 'u-1' }).success).toBe(false)
    expect(externalBorrowerSchema.safeParse({ ...contact, retainUntil: null }).success).toBe(false)
  })

  it('список контактів', () => {
    expect(externalBorrowerListResponseSchema.parse({ contacts: [contact] })).toEqual({
      contacts: [contact],
    })
  })
})
