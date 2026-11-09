import { formatDate } from '@/app/lib/labels'
import { ME, loanOf } from '../loans.test-helpers'
import { toCurrentLoansView, type CurrentLoansInput } from './current-loans-view'
import { rowAccessibleName } from './loan-row'
import { OVERDUE, statusExplanationOf } from './loan-status'

const NO_FILTERS = { query: '', status: null }

const LOANS = [
  loanOf({ id: '1984', side: 'lent', title: '1984', authors: ['Джордж Орвелл'] }),
  loanOf({
    id: 'dune',
    side: 'lent',
    status: 'REQUESTED',
    title: 'Дюна',
    authors: ['Френк Герберт'],
  }),
  loanOf({
    id: 'farm',
    side: 'borrowed',
    status: 'APPROVED',
    title: 'Колгосп тварин',
    authors: ['Джордж Орвелл'],
  }),
  loanOf({ id: 'old', side: 'borrowed', status: 'RETURNED', title: 'Атомні звички' }),
  loanOf({ id: 'lost', side: 'lent', status: 'LOST', title: 'Загублена' }),
]

const view = (input: Partial<CurrentLoansInput> = {}) =>
  toCurrentLoansView({
    loans: LOANS,
    userId: ME.id,
    parameters: new URLSearchParams(),
    side: 'all',
    filters: NO_FILTERS,
    ...input,
  })

const titles = (input: Partial<CurrentLoansInput> = {}) => view(input).rows.map((row) => row.title)

describe('поточні вкладки «Позичань» (BS-153)', () => {
  it('показують лише відкриті позики; завершені — в «Історії»', () => {
    expect(titles()).toEqual(['1984', 'Дюна', 'Колгосп тварин'])
  })

  it('лічильники — справжні підсумки відкритих позик кожного боку, без огляду на фільтри', () => {
    const counts = { all: 3, owner: 2, borrower: 1 }

    expect(view().counts).toEqual(counts)
    expect(view({ side: 'borrower', filters: { query: 'нема', status: 'LOST' } }).counts).toEqual(
      counts,
    )
  })

  it('бік береться з власника позики: «У мене позичають» і «Я позичаю»', () => {
    expect(titles({ side: 'owner' })).toEqual(['1984', 'Дюна'])
    expect(titles({ side: 'borrower' })).toEqual(['Колгосп тварин'])
    expect(view({ side: 'owner' }).rows[0]).toMatchObject({
      relation: 'У мене позичає',
      direction: 'out',
      person: { name: 'Олесь' },
    })
    expect(view({ side: 'borrower' }).rows[0]).toMatchObject({
      relation: 'Я позичаю',
      direction: 'in',
      person: { name: 'Марта Ковалів' },
    })
  })

  it('рядок веде на деталі цієї позики', () => {
    expect(view().rows[0]?.href).toBe('/loans?tab=all&loanId=1984')
  })

  describe('пошук', () => {
    it.each([
      ['орвелл', ['1984', 'Колгосп тварин']],
      ['  ДЮНА ', ['Дюна']],
      ['марта ков', ['Колгосп тварин']],
      ['олесь', ['1984', 'Дюна']],
    ])('«%s» шукає в назві, авторі й імені іншої сторони', (query, found) => {
      expect(titles({ filters: { query, status: null } })).toEqual(found)
    })

    it('апостроф будь-якого виду однаковий', () => {
      const loans = [loanOf({ id: 'mint', side: 'lent', title: 'М’ятна книжка' })]

      expect(
        toCurrentLoansView({
          loans,
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'all',
          filters: { query: "м'ятна", status: null },
        }).rows,
      ).toHaveLength(1)
    })
  })

  describe('фільтр статусу', () => {
    it('«На руках» не знаходить прострочених — у них свій статус на картці й у фільтрі', () => {
      const loans = [
        loanOf({ id: 'a', side: 'lent' }),
        loanOf({ id: 'b', side: 'lent', isOverdue: true, dueAt: '2026-10-20' }),
      ]
      const pick = (status: 'HANDED_OVER' | 'OVERDUE') =>
        toCurrentLoansView({
          loans,
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'all',
          filters: { query: '', status },
        }).rows.map((row) => row.key)

      expect(pick('HANDED_OVER')).toEqual(['a'])
      expect(pick('OVERDUE')).toEqual(['b'])
    })

    it('фільтр і пошук діють разом у вибраній вкладці', () => {
      expect(titles({ side: 'owner', filters: { query: 'орвелл', status: 'REQUESTED' } })).toEqual(
        [],
      )
      expect(
        titles({ side: 'owner', filters: { query: 'орвелл', status: 'HANDED_OVER' } }),
      ).toEqual(['1984'])
    })
  })

  describe('кількість і порожні стани', () => {
    it('без фільтрів — «3 позики»; під фільтром — «Знайдено: …»', () => {
      expect(view().resultLabel).toBe('3 позики')
      expect(view({ filters: { query: 'дюна', status: null } }).resultLabel).toBe(
        'Знайдено: 1 позика',
      )
      expect(view({ filters: { query: 'нема', status: null } }).resultLabel).toBe(
        'Знайдено: 0 позик',
      )
    })

    it('жодної відкритої позики у «Усі» — повністю порожній стан', () => {
      const finished = (['RETURNED', 'REJECTED', 'CANCELLED', 'DECLINED', 'LOST'] as const).map(
        (status) => loanOf({ id: status, side: 'lent', status }),
      )

      expect(
        toCurrentLoansView({
          loans: finished,
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'all',
          filters: NO_FILTERS,
        }),
      ).toMatchObject({ empty: 'none', rows: [], isFiltered: false })
    })

    it('порожній бік, коли в іншому позики є — компактний стан вкладки', () => {
      const lentOnly = LOANS.filter((loan) => loan.owner.id === ME.id)

      expect(
        toCurrentLoansView({
          loans: lentOnly,
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'borrower',
          filters: NO_FILTERS,
        }).empty,
      ).toBe('side')
    })

    it('порожні обидва боки — повністю порожній стан і у вкладці боку', () => {
      expect(
        toCurrentLoansView({
          loans: [],
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'owner',
          filters: NO_FILTERS,
        }).empty,
      ).toBe('none')
    })

    it('порожній список лишається порожнім станом і під пошуком: фільтр тут ні до чого', () => {
      const lentOnly = LOANS.filter((loan) => loan.owner.id === ME.id)

      expect(
        toCurrentLoansView({
          loans: lentOnly,
          userId: ME.id,
          parameters: new URLSearchParams(),
          side: 'borrower',
          filters: { query: 'Дюна', status: null },
        }),
      ).toMatchObject({ empty: 'side', resultLabel: 'Знайдено: 0 позик' })
    })

    it('«позик немає» і «фільтр нічого не знайшов» — різні стани', () => {
      expect(view({ filters: { query: 'Майстер і Маргарита', status: null } })).toMatchObject({
        empty: 'results',
        noResultsText:
          'Немає позик за запитом «Майстер і Маргарита». Перевірте написання або шукайте за автором чи ім’ям друга.',
      })
      expect(view({ side: 'owner', filters: { query: '', status: 'APPROVED' } })).toMatchObject({
        empty: 'results',
        noResultsText:
          'У цій вкладці немає позик із вибраним статусом. Спробуйте інший статус або вкладку «Усі».',
      })
    })
  })

  describe('що каже рядок', () => {
    it('прострочення — серверна ознака: бейдж «Прострочено» і дата, до якої мало повернутись', () => {
      const [row] = toCurrentLoansView({
        loans: [loanOf({ id: 'x', side: 'lent', isOverdue: true, dueAt: '2026-10-20' })],
        userId: ME.id,
        parameters: new URLSearchParams(),
        side: 'all',
        filters: NO_FILTERS,
      }).rows

      expect(row?.badge).toEqual({
        label: 'Прострочено',
        tone: 'over',
        tip: statusExplanationOf(OVERDUE),
      })
      expect(row?.hint).toEqual({
        text: `Мало повернутись ${formatDate('2026-10-20')}`,
        isAlert: true,
      })
      expect(row?.dates).toEqual([`Передано ${formatDate('2026-10-03T09:00:00.000Z')}`])
    })

    it('строк без прострочення — «Повернути до», а не повернення', () => {
      const [row] = toCurrentLoansView({
        loans: [loanOf({ id: 'x', side: 'lent', dueAt: '2026-12-01' })],
        userId: ME.id,
        parameters: new URLSearchParams(),
        side: 'all',
        filters: NO_FILTERS,
      }).rows

      expect(row?.badge).toEqual({
        label: 'На руках',
        tone: 'hold',
        tip: statusExplanationOf('HANDED_OVER'),
      })
      expect(row?.hint).toBeNull()
      expect(row?.dates).toEqual([`Повернути до ${formatDate('2026-12-01')}`])
    })

    it.each([
      ['lent', 'REQUESTED', 'Чекає вашої відповіді'],
      ['borrowed', 'REQUESTED', 'Чекає відповіді власника'],
      ['lent', 'APPROVED', 'Чекає, поки позичальник підтвердить отримання'],
      ['borrowed', 'APPROVED', 'Підтвердьте, коли отримаєте книжку'],
      ['lent', 'PENDING_CONFIRMATION', 'Чекає підтвердження позичальника'],
      ['borrowed', 'PENDING_CONFIRMATION', 'Підтвердьте або відхиліть запис'],
    ] as const)('%s %s — підказка «%s» називає наявну дію', (side, status, hint) => {
      const [row] = toCurrentLoansView({
        loans: [
          loanOf({
            id: 'x',
            side,
            status,
            origin: status === 'PENDING_CONFIRMATION' ? 'RECORDED_EXISTING' : 'REQUESTED',
          }),
        ],
        userId: ME.id,
        parameters: new URLSearchParams(),
        side: 'all',
        filters: NO_FILTERS,
      }).rows

      expect(row?.hint).toEqual({ text: hint, isAlert: false })
    })

    it('записана власником позика датується записом, а не вигаданим запитом', () => {
      const [row] = toCurrentLoansView({
        loans: [
          loanOf({
            id: 'x',
            side: 'borrowed',
            status: 'PENDING_CONFIRMATION',
            origin: 'RECORDED_EXISTING',
            createdAt: '2026-10-05T09:00:00.000Z',
            requestedAt: null,
          }),
        ],
        userId: ME.id,
        parameters: new URLSearchParams(),
        side: 'all',
        filters: NO_FILTERS,
      }).rows

      expect(row?.dates).toEqual([`Записано власником ${formatDate('2026-10-05T09:00:00.000Z')}`])
    })

    it('назва посилання складає весь рядок і закінчується дією', () => {
      const [row] = view({ side: 'borrower' }).rows

      expect(row && rowAccessibleName(row)).toBe(
        `Колгосп тварин, Джордж Орвелл. Марта Ковалів, я позичаю. Статус: Домовлено, ще не передано. Підтвердьте, коли отримаєте книжку. Погоджено ${formatDate('2026-10-02T09:00:00.000Z')} Переглянути позику`,
      )
    })
  })
})
