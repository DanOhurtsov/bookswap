import { greetingName } from './greeting'

describe('greetingName', () => {
  it('takes the first word of the display name, as written', () => {
    expect(greetingName('Данило Огурцов')).toBe('Данило')
    expect(greetingName('Олесь')).toBe('Олесь')
  })

  it('keeps a hyphenated first name whole', () => {
    expect(greetingName('Анна-Марія Коваль')).toBe('Анна-Марія')
  })

  it('ignores surrounding and repeated whitespace of any kind', () => {
    expect(greetingName('  Марта \t Коваль ')).toBe('Марта')
    expect(greetingName('\nЯрина\nБондар')).toBe('Ярина')
  })

  it('has no name to greet by when there is no word', () => {
    expect(greetingName('')).toBeNull()
    expect(greetingName('   ')).toBeNull()
  })
})
