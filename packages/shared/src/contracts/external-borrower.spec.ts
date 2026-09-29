import {
  EXTERNAL_BORROWER_LIMITS,
  GUEST_INVITATION_EMAIL_DOMAIN,
  createExternalBorrowerInvitationRequestSchema,
  createExternalBorrowerRequestSchema,
  externalBorrowerInvitationResponseSchema,
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
    guestNickname: null,
    guestEmail: null,
    guestEmailVerifiedAt: null,
  }

  it('10i.1: підтверджені гостем нікнейм/email/час перевірки — nullable рядки, owner-only', () => {
    expect(
      externalBorrowerSchema.safeParse({
        ...contact,
        guestNickname: 'Синтетичний',
        guestEmail: 'guest@guest.invalid',
        guestEmailVerifiedAt: '2026-09-29T10:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      externalBorrowerSchema.safeParse({ ...contact, guestEmailVerifiedAt: 'вчора' }).success,
    ).toBe(false)
  })

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

describe('createExternalBorrowerInvitationRequestSchema', () => {
  it('приймає адресу зарезервованого тестового домену, нормалізуючи регістр і пробіли', () => {
    expect(
      createExternalBorrowerInvitationRequestSchema.parse({
        email: `  Guest@${GUEST_INVITATION_EMAIL_DOMAIN.toUpperCase()}  `,
      }),
    ).toEqual({ email: `guest@${GUEST_INVITATION_EMAIL_DOMAIN}` })
  })

  it.each([
    ['реальний домен', 'guest@example.com'],
    ['схожий, але інший домен', `guest@${GUEST_INVITATION_EMAIL_DOMAIN}.evil.test`],
    ['некоректна адреса', 'not-an-email'],
    ['порожня адреса', ''],
  ])('відхиляє: %s', (_name, email) => {
    expect(createExternalBorrowerInvitationRequestSchema.safeParse({ email }).success).toBe(false)
  })

  it.each(['alias', 'contactId', 'note'])('відхиляє зайве поле %s', (field) => {
    expect(
      createExternalBorrowerInvitationRequestSchema.safeParse({
        email: `guest@${GUEST_INVITATION_EMAIL_DOMAIN}`,
        [field]: 'x',
      }).success,
    ).toBe(false)
  })
})

describe('externalBorrowerInvitationResponseSchema', () => {
  it('не пропускає email чи будь-яке поле, крім invitation', () => {
    const invitation = {
      id: 'inv-1',
      kind: 'EMAIL',
      status: 'ACTIVE',
      expiresAt: '2026-10-11T00:00:00.000Z',
      createdAt: '2026-09-27T00:00:00.000Z',
      acceptedCount: 0,
      maxUses: 1,
    }

    expect(externalBorrowerInvitationResponseSchema.safeParse({ invitation }).success).toBe(true)
    expect(
      externalBorrowerInvitationResponseSchema.safeParse({
        invitation,
        email: `guest@${GUEST_INVITATION_EMAIL_DOMAIN}`,
      }).success,
    ).toBe(false)
  })
})
