import { formatDate } from '@/app/lib/labels'
import { borrowedRecord, guestRecord } from '../loans.test-helpers'
import { toHistoryLoansView } from './history-loans-view'
import { rowAccessibleName } from './loan-row'
import type { LoansFilters } from './loans-address'
import { OVERDUE, statusExplanationOf } from './loan-status'

const NO_FILTERS: LoansFilters = { query: '', status: null }

const HISTORY = {
  borrowed: [
    borrowedRecord({
      id: 'habits',
      title: 'Атомні звички',
      authors: ['Джеймс Клір'],
      status: 'RETURNED',
      handedAt: '2026-08-01T09:00:00.000Z',
      returnedAt: '2026-09-03T09:00:00.000Z',
      completedAt: '2026-09-03T09:00:00.000Z',
    }),
    borrowedRecord({
      id: 'open',
      title: 'Відкрита',
      status: 'HANDED_OVER',
      latestFactAt: '2026-07-01T09:00:00.000Z',
    }),
  ],
  lent: [
    guestRecord({
      id: 'guest',
      title: 'Гостьова',
      status: 'LOST',
      guestEvidence: 'GUEST_CONFIRMED',
      handedAt: '2026-06-01T09:00:00.000Z',
      completedAt: '2026-08-15T09:00:00.000Z',
    }),
  ],
}

const view = (filters = NO_FILTERS) => toHistoryLoansView(HISTORY, filters, new URLSearchParams())

describe('«Історія» в рядках макета (BS-153 над BS-142)', () => {
  it('усі записи обох напрямків лишаються, відкриті теж — у порядку BS-142', () => {
    expect(view().rows.map((row) => row.title)).toEqual(['Атомні звички', 'Гостьова', 'Відкрита'])
    expect(view().resultLabel).toBe('3 позики')
  })

  it('записаний рядок веде на деталі позики; гостьовий без id й імені веде на історію примірника', () => {
    const [habits, guest] = view().rows

    expect(habits?.href).toBe('/loans?tab=history&loanId=loan-habits')
    expect(habits?.person).toEqual({ name: 'Марта Ковалів', avatarUrl: null })
    expect(habits && rowAccessibleName(habits)).toMatch(/Переглянути позику$/)
    expect(guest?.href).toMatch(/^\/copies\/[^/]+\/history$/)
    expect(guest?.person).toEqual({ name: null, avatarUrl: null })
    expect(guest && rowAccessibleName(guest)).toContain('Гість, ім’я не показується')
    expect(guest && rowAccessibleName(guest)).toMatch(/Переглянути історію примірника$/)
  })

  it('джерело гостьового підтвердження й походження запису збережено', () => {
    const [habits, guest] = view().rows

    expect(habits?.hint?.text).toBe('Попросили не вказано')
    expect(guest?.hint?.text).toBe('Записано власником · джерело: підтверджено гостем')
  })

  it('дати названо: передача, повернення, завершення; відсутня — «не вказано»', () => {
    const [habits, guest, open] = view().rows

    expect(habits?.dates).toEqual([
      `Передано: ${formatDate('2026-08-01T09:00:00.000Z')} · Повернено: ${formatDate('2026-09-03T09:00:00.000Z')}`,
    ])
    expect(guest?.dates).toEqual([
      `Передано: ${formatDate('2026-06-01T09:00:00.000Z')} · Повернено: не вказано · Завершено: ${formatDate('2026-08-15T09:00:00.000Z')}`,
    ])
    expect(open?.dates).toEqual(['Передано: не вказано · Повернено: не вказано'])
  })

  it('строк повернення — це строк, а не повернення', () => {
    const view = toHistoryLoansView(
      {
        borrowed: [
          borrowedRecord({ id: 'x', status: 'HANDED_OVER', dueAt: '2026-10-20', isOverdue: true }),
        ],
        lent: [],
      },
      NO_FILTERS,
      new URLSearchParams(),
    )

    expect(view.rows[0]?.dates).toContain(
      `Строк повернення до ${formatDate('2026-10-20')} · прострочено`,
    )
    expect(view.rows[0]?.badge).toEqual({
      label: 'Прострочено',
      tone: 'over',
      tip: statusExplanationOf(OVERDUE),
    })
  })

  it('фільтр «Втрачено» знаходить втрачене; відкритий запис — лише під «Усі статуси»', () => {
    expect(view({ query: '', status: 'LOST' }).rows.map((row) => row.title)).toEqual(['Гостьова'])
    expect(view({ query: '', status: 'RETURNED' }).rows.map((row) => row.title)).toEqual([
      'Атомні звички',
    ])
  })

  it('пошук — за назвою, автором та іменем; ім’я гостя не шукається, бо його немає', () => {
    expect(view({ query: 'клір', status: null }).rows.map((row) => row.title)).toEqual([
      'Атомні звички',
    ])
    expect(view({ query: 'марта', status: null }).rows).toHaveLength(2)
    expect(view({ query: 'гість', status: null })).toMatchObject({ rows: [], empty: 'results' })
  })

  it('порожня історія — свій стан, відмінний від «нічого не знайдено»', () => {
    expect(
      toHistoryLoansView({ borrowed: [], lent: [] }, NO_FILTERS, new URLSearchParams()).empty,
    ).toBe('none')
    expect(
      toHistoryLoansView(
        { borrowed: [], lent: [] },
        { query: 'x', status: null },
        new URLSearchParams(),
      ).empty,
    ).toBe('none')
    expect(view({ query: '', status: 'DECLINED' })).toMatchObject({
      empty: 'results',
      noResultsText: 'У цій вкладці немає позик із вибраним статусом. Спробуйте інший статус.',
    })
  })
})
