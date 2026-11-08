import type {
  AnonymousHistoryEntry,
  HistoryCopy,
  Loan,
  MyHistoryEntry,
  NamedHistoryEntry,
  PublicUser,
} from '@bookswap/shared'

/** Test-only: the people of the loans specs. «Я» is the signed-in reader. */
export const ME: PublicUser = {
  id: 'user-me',
  displayName: 'Я',
  handle: 'me-user',
  avatarUrl: null,
}
export const MARTA: PublicUser = {
  id: 'user-marta',
  displayName: 'Марта Ковалів',
  handle: 'marta',
  avatarUrl: null,
}
export const OLES: PublicUser = {
  id: 'user-oles',
  displayName: 'Олесь',
  handle: 'oles',
  avatarUrl: null,
}

type BookOverrides = {
  id: string
  title?: string | undefined
  authors?: string[] | undefined
  year?: number | null | undefined
}

function bookOf({ id, title = `Книга ${id}`, authors = [], year = null }: BookOverrides) {
  return {
    edition: {
      id: `ed-${id}`,
      workId: `work-${id}`,
      translationId: null,
      textKind: 'ORIGINAL' as const,
      publisher: null,
      year,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: 'PAPERBACK' as const,
      lang: 'uk',
      translator: null,
      revision: 1,
    },
    work: {
      id: `work-${id}`,
      title,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: authors.map((name, order) => ({
      id: `author-${id}-${String(order)}`,
      name,
      nameLatin: null,
      role: 'AUTHOR' as const,
      position: order,
    })),
  }
}

type LoanOverrides = Partial<Omit<Loan, 'id' | 'work' | 'edition' | 'authors'>> &
  BookOverrides & {
    /** `lent` — my copy at Олесь; `borrowed` — Марта's copy at me. */
    side: 'lent' | 'borrowed'
  }

/** Test-only: a loan as `GET /loans` sends it. */
export function loanOf({ id, title, authors, year, side, ...facts }: LoanOverrides): Loan {
  return {
    id,
    status: 'HANDED_OVER',
    isOverdue: false,
    message: null,
    responseNote: null,
    origin: 'REQUESTED',
    createdAt: '2026-10-01T09:00:00.000Z',
    requestedAt: '2026-10-01T09:00:00.000Z',
    respondedAt: '2026-10-02T09:00:00.000Z',
    handedAt: '2026-10-03T09:00:00.000Z',
    returnedAt: null,
    dueAt: null,
    owner: side === 'lent' ? ME : MARTA,
    borrower: side === 'lent' ? OLES : ME,
    copy: { id: `copy-${id}`, status: 'LENT_OUT', condition: 'GOOD', isArchived: false },
    ...bookOf({ id, title, authors, year }),
    recovery: null,
    ...facts,
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

type HistoryOverrides = Partial<
  Omit<NamedHistoryEntry, 'names' | 'loanId' | 'owner' | 'borrower'>
> &
  BookOverrides & { completedAt?: string | null; latestFactAt?: string | null }

function historyCopyOf(book: BookOverrides): HistoryCopy {
  return { id: `copy-${book.id}`, status: 'AVAILABLE', condition: 'GOOD', ...bookOf(book) }
}

/** Test-only: a `GET /me/history` record of a loan where I borrowed Марта's copy. */
export function borrowedRecord({
  id,
  title,
  authors,
  completedAt = null,
  latestFactAt = completedAt,
  ...facts
}: HistoryOverrides): MyHistoryEntry {
  return {
    entry: { ...FACTS, ...facts, names: true, loanId: `loan-${id}`, owner: MARTA, borrower: ME },
    copy: historyCopyOf({ id, title, authors }),
    completedAt,
    latestFactAt,
  }
}

/** Test-only: a record of my copy lent to a guest — anonymous, no loan id (§6.6). */
export function guestRecord({
  id,
  title,
  completedAt = null,
  latestFactAt = completedAt,
  ...facts
}: Omit<HistoryOverrides, 'authors'>): MyHistoryEntry {
  const entry: AnonymousHistoryEntry = {
    ...FACTS,
    origin: 'RECORDED_GUEST',
    ...facts,
    names: false,
  }

  return {
    entry,
    copy: historyCopyOf({ id, title }),
    completedAt,
    latestFactAt,
  }
}
