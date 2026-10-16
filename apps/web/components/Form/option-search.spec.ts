import { matchesSearch } from './option-search'

describe('matchesSearch', () => {
  it('знаходить за частиною назви без урахування регістру', () => {
    expect(matchesSearch('українська', 'УКР')).toBe(true)
    expect(matchesSearch('українська', 'раїн')).toBe(true)
  })

  it('крайні пробіли запиту не заважають, внутрішні — частина запиту', () => {
    expect(matchesSearch('українська', '  укр  ')).toBe(true)
    expect(matchesSearch('шотландська гельська', 'ська гель')).toBe(true)
    expect(matchesSearch('українська', 'укр аїнська')).toBe(false)
  })

  it('будь-який апостроф знаходить назву з ʼ', () => {
    expect(matchesSearch('вʼєтнамська', "в'єт")).toBe(true)
    expect(matchesSearch('вʼєтнамська', 'в’єт')).toBe(true)
    expect(matchesSearch('Без привʼязки до перекладу', "прив'язки")).toBe(true)
  })

  it('порожній запит або самі пробіли — усі варіанти', () => {
    expect(matchesSearch('українська', '')).toBe(true)
    expect(matchesSearch('українська', '   ')).toBe(true)
  })
})
