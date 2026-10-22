import {
  OPEN_LOAN_STATUS,
  type HistoryCopy,
  type HistoryEntry,
  type MyHistoryEntry,
  type MyHistoryResponse,
} from '@bookswap/shared'

/**
 * BS-142: the personal history as one list. Both directions of `GET /me/history` are merged and
 * ordered by when a loan ended (docs/plan/bs-142-unified-loan-history.md):
 *
 * 1. loans with a known `completedAt` first, newest ending first;
 * 2. the rest below — open loans and those whose ending was never recorded — by their latest
 *    reliable date (`latestFactAt`, derived by the server), newest first.
 *
 * Nothing is grouped or deduplicated: borrowing the same work or copy again is another row.
 */

export type HistoryDirection = 'borrowed' | 'lent'

export type LoanHistoryRow = {
  /** Unique across the list and built only from what the response already carries. */
  key: string
  direction: HistoryDirection
  entry: HistoryEntry
  copy: HistoryCopy
  /** The other side: `null` when the API sent no names (an anonymous guest record). */
  counterpart: { side: 'owner' | 'borrower'; name: string | null }
  completedAt: string | null
  /**
   * Whether the row shows its ending date of its own (known or «не вказано»). Not for an open loan,
   * and not for a returned one — its ending is the return date shown anyway.
   */
  showsCompletedAt: boolean
}

type Ranked = { row: LoanHistoryRow; order: number; sortAt: number | null }

export function toLoanHistory(history: MyHistoryResponse): LoanHistoryRow[] {
  const ranked = [...rowsOf('borrowed', history.borrowed), ...rowsOf('lent', history.lent)].map(
    (unordered, order): Ranked => ({ ...unordered, order }),
  )

  return ranked.sort(compareRanked).map(({ row }) => row)
}

function rowsOf(direction: HistoryDirection, items: MyHistoryEntry[]): Omit<Ranked, 'order'>[] {
  // An anonymous record has no loan id on purpose (§6.6); the n-th one of the same copy keeps its
  // number, so look-alike records stay separate rows with distinct keys.
  const anonymousOfCopy = new Map<string, number>()

  return items.map((item) => {
    let key: string

    if (item.entry.names) {
      key = `${direction}:${item.entry.loanId}`
    } else {
      const seen = anonymousOfCopy.get(item.copy.id) ?? 0

      anonymousOfCopy.set(item.copy.id, seen + 1)
      key = `${direction}:anonymous:${item.copy.id}:${String(seen)}`
    }

    return {
      row: {
        key,
        direction,
        entry: item.entry,
        copy: item.copy,
        counterpart: counterpartOf(direction, item.entry),
        completedAt: item.completedAt,
        showsCompletedAt: isFinished(item.entry) && item.entry.status !== 'RETURNED',
      },
      sortAt: sortTimeOf(item),
    }
  })
}

function counterpartOf(
  direction: HistoryDirection,
  entry: HistoryEntry,
): LoanHistoryRow['counterpart'] {
  if (direction === 'borrowed') {
    return { side: 'owner', name: entry.names ? entry.owner.displayName : null }
  }

  return { side: 'borrower', name: entry.names ? entry.borrower.displayName : null }
}

function isFinished(entry: HistoryEntry): boolean {
  return !OPEN_LOAN_STATUS.some((status) => status === entry.status)
}

/**
 * The date a row is ordered by inside its group: the ending, or else the latest reliable fact. Which
 * facts count is the server's decision (`latestFactAt`) — a later recovery included, `dueAt` and a
 * recorded loan's default `requestedAt` not.
 */
function sortTimeOf(item: MyHistoryEntry): number | null {
  const at = item.completedAt ?? item.latestFactAt

  return at === null ? null : Date.parse(at)
}

/** Group, then date (newest first, unknown last), then input order: borrowed before lent. */
function compareRanked(one: Ranked, other: Ranked): number {
  const group = Number(one.row.completedAt === null) - Number(other.row.completedAt === null)

  if (group !== 0) return group
  if (one.sortAt !== other.sortAt) {
    if (one.sortAt === null) return 1
    if (other.sortAt === null) return -1

    return other.sortAt - one.sortAt
  }

  return one.order - other.order
}
