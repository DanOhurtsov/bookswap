import { invitationStatusOf } from './invitation.rules'

const NOW = new Date('2026-09-25T12:00:00.000Z')
const facts = (over: Partial<Parameters<typeof invitationStatusOf>[0]> = {}) => ({
  expiresAt: new Date('2026-10-09T12:00:00.000Z'),
  revokedAt: null,
  acceptedCount: 0,
  maxUses: 10,
  ...over,
})

describe('invitationStatusOf', () => {
  it('чинне', () => expect(invitationStatusOf(facts(), NOW)).toBe('ACTIVE'))

  it('рівно на межі строку вже прострочене', () => {
    expect(invitationStatusOf(facts({ expiresAt: NOW }), NOW)).toBe('EXPIRED')
  })

  it('за мить до межі ще чинне', () => {
    expect(invitationStatusOf(facts({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      'ACTIVE',
    )
  })

  it('вичерпане при досягненні maxUses', () => {
    expect(invitationStatusOf(facts({ acceptedCount: 10 }), NOW)).toBe('EXHAUSTED')
    expect(invitationStatusOf(facts({ acceptedCount: 9 }), NOW)).toBe('ACTIVE')
  })

  it('відкликане сильніше за строк і вичерпання', () => {
    const revoked = { revokedAt: NOW, expiresAt: NOW, acceptedCount: 10 }

    expect(invitationStatusOf(facts(revoked), NOW)).toBe('REVOKED')
  })

  it('прострочене сильніше за вичерпане', () => {
    expect(invitationStatusOf(facts({ expiresAt: NOW, acceptedCount: 10 }), NOW)).toBe('EXPIRED')
  })
})
