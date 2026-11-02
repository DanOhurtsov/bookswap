import type { Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import {
  INCOMING_REQUESTS_SHOWN,
  answerConflictMessage,
  isAnswerConflict,
  toIncomingRequestsView,
} from './incoming-requests-view'

/** Local time, as the reader's calendar: «тому» counts days on it. */
const NOW = new Date(2026, 9, 30, 12).getTime()
const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString()

function request(id: string, overrides: Partial<Loan> = {}): Loan {
  return {
    id,
    status: 'REQUESTED',
    isOverdue: false,
    message: null,
    responseNote: null,
    origin: 'REQUESTED',
    createdAt: hoursAgo(2),
    requestedAt: hoursAgo(2),
    respondedAt: null,
    handedAt: null,
    returnedAt: null,
    dueAt: null,
    owner: { id: 'me', displayName: 'Я', handle: 'me', avatarUrl: null },
    borrower: { id: 'b-1', displayName: 'Ірина', handle: 'iryna', avatarUrl: null },
    copy: { id: `copy-${id}`, status: 'AVAILABLE', condition: 'GOOD', isArchived: false },
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
      title: `Твір ${id}`,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [
      { id: 'a-1', name: 'Михайло Булгаков', nameLatin: null, role: 'AUTHOR', position: 0 },
      { id: 'a-2', name: 'Співавтор', nameLatin: null, role: 'AUTHOR', position: 1 },
    ],
    recovery: null,
    ...overrides,
  }
}

const settled = { error: null, isError: false, isFetching: false, readAt: NOW }

describe('toIncomingRequestsView (BS-147)', () => {
  it('is loading until the first answer', () => {
    expect(toIncomingRequestsView({ ...settled, data: undefined, isFetching: true })).toEqual({
      kind: 'loading',
    })
  })

  it('shows a settled error with the reason, and loading while a retry is on its way', () => {
    const error = new ApiRequestError(503, {
      code: 'INTERNAL_ERROR',
      message: 'Сервер недоступний',
    })

    expect(toIncomingRequestsView({ ...settled, data: undefined, error, isError: true })).toEqual({
      kind: 'error',
      message: 'Не вдалося завантажити запити на ваші книжки. Сервер недоступний',
    })
    expect(
      toIncomingRequestsView({
        ...settled,
        data: undefined,
        error,
        isError: true,
        isFetching: true,
      }),
    ).toEqual({ kind: 'loading' })
  })

  it('hides the cards it had when a refresh fails: a request that may be gone is not offered', () => {
    const view = toIncomingRequestsView({
      ...settled,
      data: { loans: [request('1')] },
      error: new Error('Збій'),
      isError: true,
    })

    expect(view.kind).toBe('error')
  })

  it('is empty when nobody asks for anything', () => {
    expect(toIncomingRequestsView({ ...settled, data: { loans: [] } })).toEqual({ kind: 'empty' })
  })

  it('counts every request and shows the first three, in the order the API sends', () => {
    const loans = ['5', '4', '3', '2', '1'].map((id) => request(id))
    const view = toIncomingRequestsView({ ...settled, data: { loans } })

    expect(view.kind === 'ready' && view.total).toBe(5)
    expect(view.kind === 'ready' && view.totalLabel).toBe('5 запитів')
    expect(view.kind === 'ready' && view.cards.map((card) => card.loan.id)).toEqual(['5', '4', '3'])
    expect(INCOMING_REQUESTS_SHOWN).toBe(3)
  })

  it.each([
    [1, '1 запит'],
    [2, '2 запити'],
    [21, '21 запит'],
  ])('says %i requests as «%s»', (count, label) => {
    const loans = Array.from({ length: count }, (_, index) => request(String(index)))
    const view = toIncomingRequestsView({ ...settled, data: { loans } })

    expect(view.kind === 'ready' && view.totalLabel).toBe(label)
  })

  it('decides everything a card shows', () => {
    const loan = request('7', {
      dueAt: '2026-11-15',
      message: 'Давно хотіла перечитати',
      edition: { ...request('7').edition, coverUrl: 'https://covers.example/7.jpg' },
    })
    const view = toIncomingRequestsView({ ...settled, data: { loans: [loan] } })

    expect(view.kind === 'ready' && view.cards[0]).toEqual({
      loan,
      href: '/loans?loanId=7',
      borrower: loan.borrower,
      requestedAt: loan.requestedAt,
      requestedAgo: '2 год тому',
      bookId: 'work-7',
      title: 'Твір 7',
      authors: 'Михайло Булгаков, Співавтор',
      coverUrl: 'https://covers.example/7.jpg',
      proposedDue: { date: '2026-11-15', label: '15.11.26' },
      message: 'Давно хотіла перечитати',
    })
  })

  it('has no return date when the borrower proposed none, and no authors when the work has none', () => {
    const view = toIncomingRequestsView({
      ...settled,
      data: { loans: [request('8', { authors: [] })] },
    })

    expect(view.kind === 'ready' && view.cards[0]?.proposedDue).toBeNull()
    expect(view.kind === 'ready' && view.cards[0]?.authors).toBe('')
  })

  it('counts «тому» from when the list was read, not from the clock', () => {
    const view = toIncomingRequestsView({
      ...settled,
      data: { loans: [request('9', { requestedAt: hoursAgo(5) })] },
      readAt: NOW + 60 * 60 * 1000,
    })

    expect(view.kind === 'ready' && view.cards[0]?.requestedAgo).toBe('6 год тому')
  })
})

describe('isAnswerConflict (BS-147)', () => {
  const conflict = new ApiRequestError(409, {
    code: 'LOAN_INVALID_TRANSITION',
    message: 'Дія неможлива в поточному стані позичання',
  })

  it('is the answer to a request that is no longer waiting', () => {
    expect(isAnswerConflict(conflict)).toBe(true)
  })

  it.each([
    [
      'another 409',
      new ApiRequestError(409, { code: 'LOAN_COPY_STATE_MISMATCH', message: 'Збій' }),
    ],
    ['a server error', new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Збій' })],
    ['a network failure', new Error('Failed to fetch')],
    ['no failure', undefined],
  ])('is not %s', (_, failure) => {
    expect(isAnswerConflict(failure)).toBe(false)
  })

  it('names the request and gives the server reason', () => {
    expect(answerConflictMessage('Майстер і Маргарита', conflict)).toBe(
      'Не вдалося відповісти на запит на «Майстер і Маргарита». Дія неможлива в поточному стані позичання',
    )
  })
})
