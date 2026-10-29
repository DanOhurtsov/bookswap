import { initialDueDate } from './approve-due-date'

describe('initialDueDate (BS-148)', () => {
  const today = new Date(2026, 9, 27, 23, 30)

  it('дата, яку попросив позичальник, важливіша за термін власника', () => {
    expect(initialDueDate('2026-11-05', 30, today)).toBe('2026-11-05')
  })

  it('без прохання — сьогодні плюс термін власника, за місцевим календарем', () => {
    expect(initialDueDate(null, 14, today)).toBe('2026-11-10')
    expect(initialDueDate(null, 21, today)).toBe('2026-11-17')
    expect(initialDueDate(null, 30, today)).toBe('2026-11-26')
  })

  it('переходить через межу року', () => {
    expect(initialDueDate(null, 14, new Date(2026, 11, 25))).toBe('2027-01-08')
  })

  it('без прохання й без терміну — порожньо, як і раніше', () => {
    expect(initialDueDate(null, null, today)).toBe('')
  })
})
