import type { HistoryCopy, MyHistoryEntry, NamedHistoryEntry } from '@bookswap/shared'
import { toLoanHistory } from './loan-history'

const ME = { id: 'user-me', displayName: 'Я', avatarUrl: null }
const MARTA = { id: 'user-marta', displayName: 'Марта', avatarUrl: null }
const OLES = { id: 'user-oles', displayName: 'Олесь', avatarUrl: null }

function copyOf(id: string): HistoryCopy {
  return {
    id: `copy-${id}`,
    status: 'AVAILABLE',
    condition: 'GOOD',
    edition: {
      id: `ed-${id}`,
      workId: `work-${id}`,
      translationId: null,
      textKind: 'ORIGINAL',
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: 'PAPERBACK',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
    work: {
      id: `work-${id}`,
      title: `Книга ${id}`,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
  }
}

const FACTS = {
  status: 'RETURNED',
  isOverdue: false,
  origin: 'REQUESTED',
  guestEvidence: null,
  requestedAt: null,
  respondedAt: null,
  handedAt: null,
  returnedAt: null,
  dueAt: null,
} as const

type Item = {
  loanId: string
  copy?: string
  completedAt?: string | null
  latestFactAt?: string | null
} & Partial<Omit<NamedHistoryEntry, 'names' | 'loanId' | 'owner' | 'borrower'>>

/** A loan where I am the borrower: Marta owns the copy. */
function borrowed({
  loanId,
  copy = loanId,
  completedAt = null,
  latestFactAt = completedAt,
  ...facts
}: Item): MyHistoryEntry {
  return {
    entry: { ...FACTS, ...facts, names: true, loanId, owner: MARTA, borrower: ME },
    copy: copyOf(copy),
    completedAt,
    latestFactAt,
  }
}

/** A loan of my copy to Oles. */
function lent({
  loanId,
  copy = loanId,
  completedAt = null,
  latestFactAt = completedAt,
  ...facts
}: Item): MyHistoryEntry {
  return {
    entry: { ...FACTS, ...facts, names: true, loanId, owner: ME, borrower: OLES },
    copy: copyOf(copy),
    completedAt,
    latestFactAt,
  }
}

/** My copy handed to a guest: the API sends no names and no loan id. */
function toGuest(copy: string, facts: Partial<typeof FACTS> = {}): MyHistoryEntry {
  return {
    entry: {
      ...FACTS,
      status: 'HANDED_OVER',
      origin: 'RECORDED_GUEST',
      guestEvidence: 'OWNER_STATEMENT',
      handedAt: '2026-03-01T00:00:00.000Z',
      ...facts,
      names: false,
    },
    copy: copyOf(copy),
    completedAt: null,
    latestFactAt: '2026-03-01T00:00:00.000Z',
  }
}

const keys = (history: Parameters<typeof toLoanHistory>[0]) =>
  toLoanHistory(history).map((row) => row.key)

describe('спільна історія позичань (BS-142)', () => {
  it('обидва напрямки перемішані за датою завершення, а не за датою запиту', () => {
    const history = {
      borrowed: [
        borrowed({
          loanId: 'b-old-request',
          requestedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-05-01T00:00:00.000Z',
        }),
        borrowed({
          loanId: 'b-new-request',
          requestedAt: '2026-04-01T00:00:00.000Z',
          completedAt: '2026-04-10T00:00:00.000Z',
        }),
      ],
      lent: [
        lent({
          loanId: 'l-mid',
          requestedAt: '2026-02-01T00:00:00.000Z',
          completedAt: '2026-04-20T00:00:00.000Z',
        }),
      ],
    }

    expect(keys(history)).toEqual([
      'borrowed:b-old-request',
      'lent:l-mid',
      'borrowed:b-new-request',
    ])
  })

  it('записи без дати завершення збережені й стоять нижче, за останньою достовірною датою', () => {
    const history = {
      borrowed: [
        // A cancelled request: ended, but its ending was never recorded.
        borrowed({
          loanId: 'cancelled',
          status: 'CANCELLED',
          requestedAt: '2026-06-01T00:00:00.000Z',
          latestFactAt: '2026-06-01T00:00:00.000Z',
        }),
        borrowed({ loanId: 'done', completedAt: '2026-01-15T00:00:00.000Z' }),
      ],
      lent: [
        lent({
          loanId: 'handed',
          status: 'HANDED_OVER',
          requestedAt: '2026-02-01T00:00:00.000Z',
          respondedAt: '2026-02-02T00:00:00.000Z',
          handedAt: '2026-07-01T00:00:00.000Z',
          latestFactAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
    }

    expect(keys(history)).toEqual(['borrowed:done', 'lent:handed', 'borrowed:cancelled'])
  })

  it('дата запиту записаної позики (дефолт БД) і строк повернення в сортуванні не беруть участі', () => {
    const history = {
      borrowed: [
        borrowed({
          loanId: 'recorded',
          status: 'PENDING_CONFIRMATION',
          origin: 'RECORDED_EXISTING',
          requestedAt: '2026-09-01T00:00:00.000Z',
          handedAt: '2026-03-01T00:00:00.000Z',
          dueAt: '2026-12-01',
          latestFactAt: '2026-03-01T00:00:00.000Z',
        }),
      ],
      lent: [
        lent({
          loanId: 'requested',
          status: 'REQUESTED',
          requestedAt: '2026-05-01T00:00:00.000Z',
          latestFactAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
    }

    expect(keys(history)).toEqual(['lent:requested', 'borrowed:recorded'])
  })

  it('запис зовсім без дат не губиться і стоїть останнім', () => {
    const history = {
      borrowed: [
        borrowed({ loanId: 'no-dates', status: 'CANCELLED', origin: 'RECORDED_EXISTING' }),
      ],
      lent: [
        lent({
          loanId: 'dated',
          status: 'REQUESTED',
          requestedAt: '2026-01-01T00:00:00.000Z',
          latestFactAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    }

    expect(keys(history)).toEqual(['lent:dated', 'borrowed:no-dates'])
  })

  it('стара втрата без дати завершення стоїть за знахідкою у вересні — вище червневої передачі', () => {
    const history = {
      borrowed: [],
      lent: [
        // The server order is by request date: the June handover comes first there.
        lent({
          loanId: 'active',
          status: 'HANDED_OVER',
          requestedAt: '2026-02-01T00:00:00.000Z',
          respondedAt: '2026-02-02T00:00:00.000Z',
          handedAt: '2026-06-01T00:00:00.000Z',
          latestFactAt: '2026-06-01T00:00:00.000Z',
        }),
        // A loss from before Stage 10 (no LOAN_LOST), found on 1 September.
        lent({
          loanId: 'legacy-lost',
          status: 'LOST',
          requestedAt: '2026-01-01T00:00:00.000Z',
          respondedAt: '2026-01-02T00:00:00.000Z',
          handedAt: '2026-01-03T00:00:00.000Z',
          latestFactAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    }
    const rows = toLoanHistory(history)

    expect(rows.map((row) => row.key)).toEqual(['lent:legacy-lost', 'lent:active'])
    // The recovery orders the row but is not its ending.
    expect(rows[0]?.completedAt).toBeNull()
  })

  it('пізніша знахідка не зсуває запис із відомою датою завершення', () => {
    const history = {
      borrowed: [
        borrowed({
          loanId: 'returned',
          status: 'RETURNED',
          completedAt: '2026-04-01T00:00:00.000Z',
        }),
      ],
      lent: [
        lent({
          loanId: 'lost-then-found',
          status: 'LOST',
          completedAt: '2026-03-01T00:00:00.000Z',
          latestFactAt: '2026-08-01T00:00:00.000Z',
        }),
        lent({
          loanId: 'open',
          status: 'HANDED_OVER',
          handedAt: '2026-09-01T00:00:00.000Z',
          latestFactAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    }

    expect(keys(history)).toEqual(['borrowed:returned', 'lent:lost-then-found', 'lent:open'])
  })

  it('однакові дати: детерміновано — «Ви позичили» перед «Ви дали почитати», далі порядок сервера', () => {
    const at = '2026-04-01T00:00:00.000Z'
    const history = {
      borrowed: [
        borrowed({ loanId: 'b1', completedAt: at }),
        borrowed({ loanId: 'b2', completedAt: at }),
      ],
      lent: [lent({ loanId: 'l1', completedAt: at }), lent({ loanId: 'l2', completedAt: at })],
    }

    expect(keys(history)).toEqual(['borrowed:b1', 'borrowed:b2', 'lent:l1', 'lent:l2'])
    expect(keys({ lent: history.lent, borrowed: history.borrowed })).toEqual(keys(history))
  })

  it('повторні позичання того самого примірника — окремі записи з різними ключами', () => {
    const history = {
      borrowed: [
        borrowed({ loanId: 'first', copy: 'same', completedAt: '2026-02-01T00:00:00.000Z' }),
        borrowed({ loanId: 'second', copy: 'same', completedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      lent: [],
    }
    const rows = toLoanHistory(history)

    expect(rows.map((row) => row.copy.id)).toEqual(['copy-same', 'copy-same'])
    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })

  it('схожі анонімні записи лишаються окремими рядками з різними ключами без нових ідентифікаторів', () => {
    const history = {
      borrowed: [],
      lent: [toGuest('shelf'), toGuest('shelf'), toGuest('other')],
    }
    const rows = toLoanHistory(history)

    expect(rows.map((row) => row.key)).toEqual([
      'lent:anonymous:copy-shelf:0',
      'lent:anonymous:copy-shelf:1',
      'lent:anonymous:copy-other:0',
    ])
    expect(rows.every((row) => !row.entry.names)).toBe(true)
  })

  it('однаковий loanId в обох напрямках не дає однакових ключів', () => {
    expect(
      new Set(keys({ borrowed: [borrowed({ loanId: 'x' })], lent: [lent({ loanId: 'x' })] })).size,
    ).toBe(2)
  })

  it('напрямок і інший учасник правильні для обох ролей, гість — без імені', () => {
    const rows = toLoanHistory({
      borrowed: [borrowed({ loanId: 'b', completedAt: '2026-03-01T00:00:00.000Z' })],
      lent: [lent({ loanId: 'l', completedAt: '2026-02-01T00:00:00.000Z' }), toGuest('g')],
    })

    expect(rows.map(({ direction, counterpart }) => ({ direction, counterpart }))).toEqual([
      { direction: 'borrowed', counterpart: { side: 'owner', name: 'Марта' } },
      { direction: 'lent', counterpart: { side: 'borrower', name: 'Олесь' } },
      { direction: 'lent', counterpart: { side: 'borrower', name: null } },
    ])
  })

  it.each([
    ['REJECTED', true],
    ['CANCELLED', true],
    ['DECLINED', true],
    ['LOST', true],
    ['RETURNED', false],
    ['REQUESTED', false],
    ['APPROVED', false],
    ['HANDED_OVER', false],
    ['PENDING_CONFIRMATION', false],
  ] as const)('%s: окрема дата завершення показується — %s', (status, shown) => {
    const [row] = toLoanHistory({ borrowed: [borrowed({ loanId: 'x', status })], lent: [] })

    expect(row?.showsCompletedAt).toBe(shown)
  })

  it('порожні обидва напрямки — порожня історія; один порожній напрямок — ні', () => {
    expect(toLoanHistory({ borrowed: [], lent: [] })).toEqual([])
    expect(toLoanHistory({ borrowed: [], lent: [toGuest('g')] })).toHaveLength(1)
  })
})
