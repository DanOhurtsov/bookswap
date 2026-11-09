import { LOAN_STATUS, OPEN_LOAN_STATUS } from '@bookswap/shared'
import { LOAN_STATUS_LABELS } from '@/app/lib/labels'
import {
  CURRENT_STATUS_FILTERS,
  HISTORY_STATUS_FILTERS,
  OVERDUE,
  badgeToneOf,
  shownStatusLabel,
  shownStatusOf,
  statusExplanationOf,
} from './loan-status'

describe('статус позики на сторінці «Позичання» (BS-153)', () => {
  it('прострочення — серверна ознака isOverdue, а не новий статус', () => {
    expect(shownStatusOf({ status: 'HANDED_OVER', isOverdue: true })).toBe(OVERDUE)
    expect(shownStatusOf({ status: 'HANDED_OVER', isOverdue: false })).toBe('HANDED_OVER')
    expect(LOAN_STATUS).not.toContain(OVERDUE)
  })

  it('поточні й історичні фільтри разом покривають кожен статус моделі рівно раз', () => {
    const statuses = [...CURRENT_STATUS_FILTERS, ...HISTORY_STATUS_FILTERS].filter(
      (status) => status !== OVERDUE,
    )

    expect([...statuses].sort()).toEqual([...LOAN_STATUS].sort())
    expect(CURRENT_STATUS_FILTERS.filter((status) => status !== OVERDUE)).toEqual([
      ...OPEN_LOAN_STATUS,
    ])
  })

  it('«Втрачено» — не відкритий статус: його фільтрують в «Історії»', () => {
    expect(HISTORY_STATUS_FILTERS).toContain('LOST')
    expect(CURRENT_STATUS_FILTERS).not.toContain('LOST')
  })

  it('підписи — лише з LOAN_STATUS_LABELS, крім похідного «Прострочено»', () => {
    for (const status of LOAN_STATUS) {
      expect(shownStatusLabel(status)).toBe(LOAN_STATUS_LABELS[status])
    }
    expect(shownStatusLabel(OVERDUE)).toBe('Прострочено')
  })

  it.each([
    ['REQUESTED', 'wait'],
    ['PENDING_CONFIRMATION', 'wait'],
    ['APPROVED', 'agreed'],
    ['HANDED_OVER', 'hold'],
    [OVERDUE, 'over'],
    ['LOST', 'over'],
    ['RETURNED', 'done'],
    ['REJECTED', 'done'],
    ['CANCELLED', 'done'],
    ['DECLINED', 'done'],
  ] as const)('%s — колір бейджа %s', (status, tone) => {
    expect(badgeToneOf(status)).toBe(tone)
  })

  describe('пояснення статусу для підказки', () => {
    const ALL_SHOWN = [...CURRENT_STATUS_FILTERS, ...HISTORY_STATUS_FILTERS]

    it('кожен статус, який показує сторінка, пояснено окремим реченням', () => {
      const texts = ALL_SHOWN.map(statusExplanationOf)

      expect(new Set(texts).size).toBe(ALL_SHOWN.length)
      for (const text of texts) expect(text).toMatch(/^[А-ЯІЄЇҐ].+\.$/u)
    })

    it('отримання підтверджує позичальник, повернення позначає власник', () => {
      expect(statusExplanationOf('APPROVED')).toMatch(/Позичальник підтверджує/)
      expect(statusExplanationOf('HANDED_OVER')).toMatch(/Повернення позначає власник/)
    })

    it('жоден статус не обіцяє дій, яких у продукті немає', () => {
      for (const status of ALL_SHOWN) {
        expect(statusExplanationOf(status)).not.toMatch(/нагада|продовж|сповіст|повідом/iu)
      }
    })
  })
})
