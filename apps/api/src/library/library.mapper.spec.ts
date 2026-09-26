import {
  groupByEdition,
  isHome,
  ownerLoanOf,
  pendingRequestCountOf,
  toBorrowedCopy,
  toOwnCopy,
  toVisibleCopy,
  viewerLoanOf,
  type CopyLoanRow,
  type CopyRow,
  type Viewer,
} from './library.mapper'
import type { ViewerRole } from '../access/visibility'

/**
 * §9 у частині «що саме віддається назовні» перевіряється тут — чистими
 * функціями, без PostgreSQL. Ключова вимога етапу: приватні поля не повертаються
 * з API, а не ховаються в UI. Тому нижче перевіряється **відсутність** ключів, а
 * не їхнє значення: `note: null` у відповіді теж був би витоком — він каже, що
 * нотатки немає.
 */

const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: 'https://example.com/o.png' }

function copyRow(overrides: Partial<CopyRow> = {}): CopyRow {
  return {
    id: 'copy-1',
    ownerId: MARTA.id,
    currentHolderId: MARTA.id,
    heldByContactId: null,
    status: 'AVAILABLE',
    visibility: 'FRIENDS',
    condition: 'GOOD',
    note: 'кавова пляма на 213-й',
    acquiredAt: new Date('2026-03-01T00:00:00.000Z'),
    createdAt: new Date('2026-03-02T10:00:00.000Z'),
    owner: MARTA,
    currentHolder: MARTA,
    loans: [],
    edition: {
      id: 'edition-1',
      workId: 'work-1',
      translationId: 'translation-1',
      publisher: 'КСД',
      year: 2019,
      isbn13: '9786171262737',
      pageCount: 800,
      coverUrl: null,
      format: 'HARDCOVER',
      revision: 1,
      translation: { lang: 'uk', translator: 'Любов Пилаєва' },
      work: {
        id: 'work-1',
        title: 'Шантарам',
        origLang: 'en',
        firstPubYear: 2003,
        description: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        revision: 1,
        authors: [
          {
            role: 'AUTHOR',
            position: 0,
            author: { id: 'a-1', name: 'Ґреґорі Робертс', nameLatin: null },
          },
        ],
      },
    },
    ...overrides,
  }
}

const lentOut = (): CopyRow =>
  copyRow({ id: 'copy-2', status: 'LENT_OUT', currentHolderId: OLES.id, currentHolder: OLES })

function loanRow(overrides: Partial<CopyLoanRow> = {}): CopyLoanRow {
  return {
    id: 'loan-1',
    status: 'REQUESTED',
    borrowerId: OLES.id,
    borrower: OLES,
    dueAt: null,
    ...overrides,
  }
}

const BOHDAN = { id: 'user-bohdan', displayName: 'Богдан', avatarUrl: null }

/**
 * Типовий гість чужої полиці — друг власника.
 *
 * Роль тут не декоративна: від неї залежить `canRequest`, а `/users/:id/library`
 * за §9 віддає бібліотеку не лише друзям.
 */
const guest = (showHolderNames: boolean, role: ViewerRole = 'FRIEND'): Viewer => ({
  id: OLES.id,
  role,
  showHolderNames,
})

describe('isHome', () => {
  it('вдома — це тримач, який дорівнює власнику (інваріант §5.3.2)', () => {
    expect(isHome(copyRow())).toBe(true)
    expect(isHome(lentOut())).toBe(false)
  })

  /** Stage 10 (T1-a): гість-тримач і невідомий тримач (стерто за D3) — «не вдома». */
  it('тримач-гість чи NULL-тримач — не вдома', () => {
    expect(isHome(copyRow({ currentHolderId: null, heldByContactId: 'contact-1' }))).toBe(false)
    expect(isHome(copyRow({ currentHolderId: null, heldByContactId: null }))).toBe(false)
  })
})

describe('копія в гостя (Stage 10, T1-a)', () => {
  const heldByGuest = (): CopyRow =>
    copyRow({
      status: 'LENT_OUT',
      currentHolderId: null,
      heldByContactId: 'contact-1',
      currentHolder: null,
    })

  it('власник: не вдома, тримача-користувача немає', () => {
    const copy = toOwnCopy(heldByGuest())

    expect(copy.isHome).toBe(false)
    expect(copy.holder).toBeNull()
  })

  it('друг навіть із showHolderNames = true не бачить нічого про гостя (D4)', () => {
    const copy = toVisibleCopy(heldByGuest(), guest(true))

    expect(copy.isHome).toBe(false)
    expect(copy.holder).toBeNull()
    expect(copy.canRequest).toBe(false)
  })

  it('активна гостьова позика не ламає ownerLoanOf', () => {
    const row = heldByGuest()

    row.loans = [
      { id: 'loan-g', status: 'HANDED_OVER', borrowerId: null, dueAt: null, borrower: null },
    ]

    expect(toOwnCopy(row).activeLoan).toBeNull()
  })
})

describe('toOwnCopy', () => {
  it('власник бачить нотатку, дату придбання й видимість', () => {
    const copy = toOwnCopy(copyRow())

    expect(copy.note).toBe('кавова пляма на 213-й')
    expect(copy.acquiredAt).toBe('2026-03-01')
    expect(copy.visibility).toBe('FRIENDS')
  })

  it('дата придбання — без часу', () => {
    expect(toOwnCopy(copyRow()).acquiredAt).not.toContain('T')
    expect(toOwnCopy(copyRow({ acquiredAt: null })).acquiredAt).toBeNull()
  })

  it('вдома тримача немає, поза домом — є', () => {
    expect(toOwnCopy(copyRow()).holder).toBeNull()
    expect(toOwnCopy(lentOut()).holder).toEqual(OLES)
  })

  it('власник бачить імʼя тримача незалежно від власного showHolderNames (§6.6)', () => {
    // Прапорець керує тим, що бачать ІНШІ; сюди він не передається взагалі —
    // саме тому в `toOwnCopy` немає відповідного параметра.
    expect(toOwnCopy(lentOut()).holder?.displayName).toBe('Олесь')
  })
})

describe('toVisibleCopy', () => {
  it('не віддає приватних полів власника (§9)', () => {
    const copy = toVisibleCopy(copyRow(), guest(true))

    expect(copy).not.toHaveProperty('note')
    expect(copy).not.toHaveProperty('acquiredAt')
    expect(copy).not.toHaveProperty('visibility')
    expect(copy).not.toHaveProperty('createdAt')
  })

  it('віддає те, що потрібно для рішення «просити чи ні» (§6.5)', () => {
    const copy = toVisibleCopy(lentOut(), guest(true))

    expect(copy.status).toBe('LENT_OUT')
    expect(copy.condition).toBe('GOOD')
    expect(copy.isHome).toBe(false)
  })

  it('імʼя тримача приховується, коли §6.6 не дозволяє — але статус лишається', () => {
    const hidden = toVisibleCopy(lentOut(), guest(false))

    expect(hidden.holder).toBeNull()
    expect(hidden.isHome).toBe(false)
  })

  it('вдома тримача немає навіть з дозволеними іменами — це власник', () => {
    expect(toVisibleCopy(copyRow(), guest(true)).holder).toBeNull()
  })
})

describe('toBorrowedCopy', () => {
  it('показує власника — інакше незрозуміло, кому повертати', () => {
    expect(toBorrowedCopy(copyRow(), OLES.id).owner).toEqual(MARTA)
  })

  it('не віддає нотаток власника: книжка в мене — не доступ до його записів', () => {
    const copy = toBorrowedCopy(copyRow(), OLES.id)

    expect(copy).not.toHaveProperty('note')
    expect(copy).not.toHaveProperty('visibility')
    expect(copy).not.toHaveProperty('acquiredAt')
  })
})

describe('контекст позичання (§6.5)', () => {
  it('свій запит видно, чужий — ні: гість не бачить черги', () => {
    const copy = copyRow({
      loans: [
        loanRow({ id: 'loan-oles' }),
        loanRow({ id: 'loan-bohdan', borrowerId: BOHDAN.id, borrower: BOHDAN }),
      ],
    })

    expect(viewerLoanOf(copy, OLES.id)).toEqual({ id: 'loan-oles', status: 'REQUESTED' })
    expect(viewerLoanOf(copy, BOHDAN.id)).toEqual({ id: 'loan-bohdan', status: 'REQUESTED' })
    expect(viewerLoanOf(copy, 'user-стороння')).toBeNull()
  })

  it('REQUESTED не змінює Copy.status, тож кнопку тримає саме лоан, а не статус', () => {
    // §5.1: перехід «— → REQUESTED» примірника не чіпає взагалі. Якби фронт
    // вирішував за `status`, він намалював би «Попросити» вдруге.
    const copy = copyRow({ loans: [loanRow()] })

    expect(copy.status).toBe('AVAILABLE')
    expect(toVisibleCopy(copy, guest(true)).myActiveLoan).toEqual({
      id: 'loan-1',
      status: 'REQUESTED',
    })
  })

  it('бере найдальший за перебігом лоан, а не перший у списку', () => {
    const copy = copyRow({
      loans: [loanRow({ id: 'loan-old' }), loanRow({ id: 'loan-new', status: 'HANDED_OVER' })],
    })

    expect(viewerLoanOf(copy, OLES.id)).toEqual({ id: 'loan-new', status: 'HANDED_OVER' })
  })

  it('власник бачить єдиний ексклюзивний лоан і чергу окремим числом', () => {
    const copy = copyRow({
      loans: [
        loanRow({ id: 'loan-approved', status: 'APPROVED' }),
        loanRow({ id: 'loan-q1', borrowerId: BOHDAN.id, borrower: BOHDAN }),
        loanRow({ id: 'loan-q2', borrowerId: 'user-x', borrower: { ...BOHDAN, id: 'user-x' } }),
      ],
    })
    const own = toOwnCopy(copy)

    expect(own.activeLoan).toEqual({
      id: 'loan-approved',
      status: 'APPROVED',
      counterpart: OLES,
    })
    // Два різні питання — два різні поля: `REQUESTED` може бути кілька (§5.2),
    // а ексклюзивний лоан завжди один (§5.3.1).
    expect(own.pendingRequestCount).toBe(2)
  })

  it('без лоанів обидва поля порожні', () => {
    const own = toOwnCopy(copyRow())

    expect(own.activeLoan).toBeNull()
    expect(own.pendingRequestCount).toBe(0)
    expect(ownerLoanOf(copyRow())).toBeNull()
    expect(pendingRequestCountOf(copyRow())).toBe(0)
  })

  it('«чужі в мене» веде на той лоан, яким книжка сюди потрапила', () => {
    const copy = copyRow({
      status: 'LENT_OUT',
      currentHolderId: OLES.id,
      currentHolder: OLES,
      loans: [loanRow({ id: 'loan-held', status: 'HANDED_OVER' })],
    })

    expect(toBorrowedCopy(copy, OLES.id).activeLoan).toEqual({
      id: 'loan-held',
      status: 'HANDED_OVER',
    })
  })
})

describe('canRequest — capability, а не здогад інтерфейсу (§6.5, §9)', () => {
  it('друг може попросити вільний примірник', () => {
    expect(toVisibleCopy(copyRow(), guest(true)).canRequest).toBe(true)
  })

  it('сторонній не може — §9 дозволяє запит лише другові', () => {
    // `/users/:id/library` віддає PUBLIC-полицю будь-кому, тож сам факт, що
    // примірник видно, кнопку не виправдовує: POST дав би 403.
    expect(toVisibleCopy(copyRow(), guest(true, 'OTHER')).canRequest).toBe(false)
  })

  it('власник не може попросити сам у себе', () => {
    // Роль OWNER буває на цьому маршруті: власник бачить свою полицю завжди.
    const own: Viewer = { id: MARTA.id, role: 'OWNER', showHolderNames: true }

    expect(toVisibleCopy(copyRow(), own).canRequest).toBe(false)
  })

  it('заблокований не може', () => {
    expect(toVisibleCopy(copyRow(), guest(true, 'BLOCKED')).canRequest).toBe(false)
  })

  it.each(['RESERVED', 'LENT_OUT', 'UNAVAILABLE'] as const)(
    'примірник у стані %s попросити не можна (§6.5: кнопка лише для AVAILABLE)',
    (status) => {
      // `LENT_OUT` вимагає чужого тримача — інакше рядок порушив би
      // `copy_lent_out_is_away`, і тест перевіряв би неможливий стан.
      const away = status === 'LENT_OUT'
      const copy = copyRow({
        status,
        ...(away ? { currentHolderId: BOHDAN.id, currentHolder: BOHDAN } : {}),
      })

      expect(toVisibleCopy(copy, guest(true)).canRequest).toBe(false)
    },
  )

  it('той, хто вже попросив, кнопки не бачить — попри AVAILABLE', () => {
    // Саме той випадок, заради якого capability існує: за §5.1 запит примірника
    // не змінює, тож статус лишається AVAILABLE, а другий POST дав би 409.
    const copy = copyRow({ loans: [loanRow()] })

    expect(copy.status).toBe('AVAILABLE')
    expect(toVisibleCopy(copy, guest(true)).canRequest).toBe(false)
  })

  it('чужий запит на цей примірник кнопку не забирає (§5.2)', () => {
    const copy = copyRow({
      loans: [loanRow({ id: 'loan-bohdan', borrowerId: BOHDAN.id, borrower: BOHDAN })],
    })

    expect(toVisibleCopy(copy, guest(true)).canRequest).toBe(true)
  })
})

describe('expectedReturnAt — орієнтовна дата повернення (§6.5)', () => {
  /**
   * Книжка в **третьої** людини, не в глядача.
   *
   * Це принципово для перевірки витоку: якби позичальником був сам глядач, його
   * `myActiveLoan` законно ніс би id лоану, і тест зеленів би, нічого не довівши.
   */
  const withExclusive = (status: 'RESERVED' | 'LENT_OUT', dueAt: Date | null): CopyRow =>
    copyRow({
      status,
      ...(status === 'LENT_OUT' ? { currentHolderId: BOHDAN.id, currentHolder: BOHDAN } : {}),
      loans: [
        loanRow({
          id: 'loan-active',
          status: status === 'LENT_OUT' ? 'HANDED_OVER' : 'APPROVED',
          borrowerId: BOHDAN.id,
          borrower: BOHDAN,
          dueAt,
        }),
      ],
    })

  it.each(['RESERVED', 'LENT_OUT'] as const)('віддає дату для %s', (status) => {
    const copy = withExclusive(status, new Date('2026-06-12T23:59:59.999Z'))

    expect(toVisibleCopy(copy, guest(true)).expectedReturnAt).toBe('2026-06-12')
  })

  it('без указаної дати лишається null — §6.5 каже «якщо власник її вказав»', () => {
    expect(toVisibleCopy(withExclusive('LENT_OUT', null), guest(true)).expectedReturnAt).toBeNull()
  })

  it('Stage 10 (10e): непідтверджений запис (PENDING_CONFIRMATION) дати не віддає — це претензія, а не факт', () => {
    const pending = copyRow({
      status: 'RESERVED',
      loans: [
        loanRow({
          id: 'loan-record',
          status: 'PENDING_CONFIRMATION',
          borrowerId: BOHDAN.id,
          borrower: BOHDAN,
          dueAt: new Date('2026-06-12T23:59:59.999Z'),
        }),
      ],
    })

    expect(toVisibleCopy(pending, guest(true)).expectedReturnAt).toBeNull()
    expect(toVisibleCopy(pending, guest(true)).canRequest).toBe(false)
  })

  it('для вільного примірника дати немає — вона там безглузда', () => {
    expect(toVisibleCopy(copyRow(), guest(true)).expectedReturnAt).toBeNull()
  })

  it('UNAVAILABLE дати не отримує: ніхто не обіцяв повернення', () => {
    // Це або «власник не дає», або §5.1 LOST. В обох випадках дата обіцяла б те,
    // чого немає.
    const lost = copyRow({
      status: 'UNAVAILABLE',
      currentHolderId: OLES.id,
      currentHolder: OLES,
      loans: [],
    })

    expect(toVisibleCopy(lost, guest(true)).expectedReturnAt).toBeNull()
  })

  it('дата не залежить від showHolderNames — це факт про річ, а не про людину', () => {
    const copy = withExclusive('LENT_OUT', new Date('2026-06-12T23:59:59.999Z'))

    expect(toVisibleCopy(copy, guest(false)).expectedReturnAt).toBe('2026-06-12')
    expect(toVisibleCopy(copy, guest(false)).holder).toBeNull()
  })

  it('разом із датою не витікає ані позичальник, ані id лоану', () => {
    const copy = withExclusive('LENT_OUT', new Date('2026-06-12T23:59:59.999Z'))
    const raw = JSON.stringify(toVisibleCopy(copy, guest(false)))

    expect(raw).not.toContain('loan-active')
    expect(raw).not.toContain(BOHDAN.id)
    expect(raw).not.toContain('Богдан')
    // Дата при цьому лишається — саме її §6.5 і обіцяє.
    expect(raw).toContain('2026-06-12')
  })
})

describe('groupByEdition', () => {
  it('складає примірники одного видання в одну групу, не втрачаючи жодного (§3)', () => {
    const groups = groupByEdition(
      [copyRow(), copyRow({ id: 'copy-2' }), copyRow({ id: 'copy-3' })],
      toOwnCopy,
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.copies.map((copy) => copy.id)).toEqual(['copy-1', 'copy-2', 'copy-3'])
    expect(groups[0]?.counts).toEqual({ total: 3, home: 3, out: 0 })
  })

  it('рахує «×3 · 2 вдома, 1 у Марка» (§6.4)', () => {
    const groups = groupByEdition([copyRow(), copyRow({ id: 'copy-3' }), lentOut()], toOwnCopy)

    expect(groups[0]?.counts).toEqual({ total: 3, home: 2, out: 1 })
  })

  it('розділяє різні видання', () => {
    const other = copyRow({
      id: 'copy-9',
      edition: { ...copyRow().edition, id: 'edition-2', publisher: 'Астролябія', year: 2021 },
    })

    expect(groupByEdition([copyRow(), other], toOwnCopy)).toHaveLength(2)
  })

  it('віддає обчислені поля видання: мову перекладу й перекладача', () => {
    const [group] = groupByEdition([copyRow()], toOwnCopy)

    expect(group?.edition.lang).toBe('uk')
    expect(group?.edition.translator).toBe('Любов Пилаєва')
  })

  it('для видання мовою оригіналу мова береться з твору, перекладача немає', () => {
    const original = copyRow({
      edition: { ...copyRow().edition, translationId: null, translation: null },
    })
    const [group] = groupByEdition([original], toOwnCopy)

    expect(group?.edition.lang).toBe('en')
    expect(group?.edition.translator).toBeNull()
  })

  it('порожній список — це порожній список, а не помилка', () => {
    expect(groupByEdition([], toOwnCopy)).toEqual([])
  })

  it('лічильники чужої бібліотеки рахують лише видимі примірники', () => {
    // Приховані примірники сюди просто не потрапляють — їх відфільтровує §9 до
    // групування. Інакше «×3» на сторінці друга розкривало б наявність книжок,
    // які він сховав.
    const groups = groupByEdition([copyRow()], (copy) => toVisibleCopy(copy, guest(false)))

    expect(groups[0]?.counts).toEqual({ total: 1, home: 1, out: 0 })
  })
})
