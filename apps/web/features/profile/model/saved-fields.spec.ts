import type { Me } from '@bookswap/shared'
import { savedFields } from './saved-fields'

const saved: Me = {
  id: 'user-1',
  email: 'marta@example.com',
  emailVerified: true,
  displayName: 'Марта К',
  handle: 'marta',
  city: null,
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  friendsOfFriendsAccess: false,
  loanRequestsPaused: true,
  defaultLoanTermDays: null,
  ownerDueReminders: true,
  createdAt: '2026-09-05T08:00:00.000Z',
}

describe('savedFields', () => {
  it('бере з відповіді лише поля, які змінював запит, — як їх зберіг сервер', () => {
    expect(savedFields(saved, { displayName: ' Марта К ', city: null })).toEqual({
      displayName: 'Марта К',
      city: null,
    })
    expect(savedFields(saved, { loanRequestsPaused: true })).toEqual({ loanRequestsPaused: true })
  })

  it('решту профілю з відповіді не переносить: вона може бути старшою за іншу відповідь', () => {
    const picked = savedFields(saved, { bio: 'Читаю' })

    expect(picked).not.toHaveProperty('avatarUrl')
    expect(picked).not.toHaveProperty('loanRequestsPaused')
  })
})
