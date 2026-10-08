import { describeEffectiveVisibility, effectiveVisibility } from './effective-visibility'

describe('effectiveVisibility', () => {
  it.each([
    ['PUBLIC', 'PUBLIC', 'PUBLIC'],
    ['PUBLIC', 'FRIENDS', 'FRIENDS'],
    ['PUBLIC', 'PRIVATE', 'PRIVATE'],
    ['FRIENDS', 'PUBLIC', 'FRIENDS'],
    ['FRIENDS', 'PRIVATE', 'PRIVATE'],
    ['PRIVATE', 'PUBLIC', 'PRIVATE'],
    ['PRIVATE', 'FRIENDS', 'PRIVATE'],
  ] as const)('бібліотека %s, примірник %s → %s', (library, copy, expected) => {
    expect(effectiveVisibility(library, copy)).toBe(expected)
  })
})

describe('describeEffectiveVisibility', () => {
  it('PUBLIC примірника не відкриває приватну бібліотеку, і це сказано', () => {
    const text = describeEffectiveVisibility('PRIVATE', 'PUBLIC')

    expect(text).toContain('лише ви')
    expect(text).toContain('Суворіше обмеження вашої бібліотеки')
  })

  it('без розбіжності пояснення про суворіше обмеження немає', () => {
    expect(describeEffectiveVisibility('FRIENDS', 'FRIENDS')).toBe('Бачить: ваші друзі.')
  })
})
