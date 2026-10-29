import { AVATAR_RULES } from '@bookswap/shared'
import { avatarFileProblem } from './use-avatar-upload'

describe('avatarFileProblem', () => {
  it('JPG, PNG і WebP до 5 МБ — без зауважень', () => {
    for (const type of AVATAR_RULES.types) {
      expect(avatarFileProblem({ type, size: AVATAR_RULES.maxBytes })).toBeNull()
    }
  })

  it('інший тип і завеликий файл не надсилаються — словами макета', () => {
    expect(avatarFileProblem({ type: 'image/gif', size: 1000 })).toBe(
      'Підтримуються JPG, PNG і WebP',
    )
    expect(avatarFileProblem({ type: 'image/png', size: AVATAR_RULES.maxBytes + 1 })).toBe(
      'Файл завеликий — до 5 МБ',
    )
  })

  it('невідомий тип вирішує сервер за байтами', () => {
    expect(avatarFileProblem({ type: '', size: 1000 })).toBeNull()
  })
})
