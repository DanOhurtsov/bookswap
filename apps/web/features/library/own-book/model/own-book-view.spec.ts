import { ownBookFixture } from '../own-book.test-helpers'
import { toOwnBookView } from './own-book-view'

describe('toOwnBookView', () => {
  it('names the copy in the owner’s words and points at the general page of the work', () => {
    const view = toOwnBookView(ownBookFixture())

    expect(view).toMatchObject({
      title: 'Кобзар',
      workId: 'work-1',
      workHref: '/works/work-1',
      statusLabel: 'Вдома, вільна',
      conditionLabel: 'Добрий стан',
      visibilityLabel: 'Для друзів',
      note: 'з автографом',
    })
  })

  it('writes the acquisition day as day.month.year without going through a Date', () => {
    expect(toOwnBookView(ownBookFixture({ acquiredAt: '2026-08-05' })).acquiredLabel).toBe(
      '05.08.2026',
    )
    expect(toOwnBookView(ownBookFixture({ acquiredAt: null })).acquiredLabel).toBeNull()
  })

  it('names the holder only when the copy is not at home', () => {
    expect(toOwnBookView(ownBookFixture()).holderLabel).toBeNull()

    const holder = { id: 'friend-1', displayName: 'Марта', avatarUrl: null }

    expect(toOwnBookView(ownBookFixture({ isHome: false, holder })).holderLabel).toBe(
      'Зараз у: Марта',
    )
    expect(toOwnBookView(ownBookFixture({ isHome: false, holder: null })).holderLabel).toBe(
      'Зараз не вдома',
    )
  })

  it('keeps an absent note absent', () => {
    expect(toOwnBookView(ownBookFixture({ note: null })).note).toBeNull()
  })
})
