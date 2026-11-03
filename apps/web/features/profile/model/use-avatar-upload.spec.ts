import { AVATAR_RULES } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { avatarFailureMessage, avatarFileProblem, shownAvatarUrl } from './use-avatar-upload'

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

describe('shownAvatarUrl', () => {
  const saved = 'https://avatars.example/avatars/user-1/a.webp'
  const file = new File([new Uint8Array([1])], 'me.jpg', { type: 'image/jpeg' })

  it('без змін — збережене фото або ініціали', () => {
    expect(shownAvatarUrl({ kind: 'unchanged' }, saved)).toBe(saved)
    expect(shownAvatarUrl({ kind: 'unchanged' }, null)).toBeNull()
  })

  it('вибраний файл показується локальним прев’ю замість збереженого', () => {
    expect(shownAvatarUrl({ kind: 'replace', file, previewUrl: 'blob:preview' }, saved)).toBe(
      'blob:preview',
    )
  })

  it('позначене до видалення — ініціали, хоч фото ще збережене', () => {
    expect(shownAvatarUrl({ kind: 'remove' }, saved)).toBeNull()
  })
})

describe('avatarFailureMessage', () => {
  const timeout = new DOMException('signal timed out', 'TimeoutError')

  it('таймаут — результат невідомий, повтор — власне «Зберегти»', () => {
    expect(avatarFailureMessage(timeout, 'upload')).toBe(
      'Сервер не відповів вчасно — невідомо, чи збереглося фото. Натисніть «Зберегти», щоб спробувати ще раз.',
    )
    expect(avatarFailureMessage(timeout, 'remove')).toBe(
      'Сервер не відповів вчасно — невідомо, чи видалилося фото. Натисніть «Зберегти», щоб спробувати ще раз.',
    )
  })

  it('відповідь сервера — його словами', () => {
    const refusal = new ApiRequestError(422, { code: 'AVATAR_TOO_SMALL', message: 'Фото замале' })

    expect(avatarFailureMessage(refusal, 'upload')).toBe('Фото замале')
  })
})
