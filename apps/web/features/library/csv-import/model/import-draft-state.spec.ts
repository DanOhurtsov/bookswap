import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { buildDraft, buildRow } from '../library-import.test-helpers'
import { IMPORT_CATALOG_RETRY_LABEL } from './import-labels'
import {
  classifyImportFailure,
  countImportRows,
  rowsAwaitingRetry,
  selectImportRows,
} from './import-draft-state'

function apiError(status: number, code: string, details?: unknown): ApiRequestError {
  return new ApiRequestError(status, {
    code: code as ApiRequestError['code'],
    message: `повідомлення ${code}`,
    ...(details === undefined ? {} : { details }),
  })
}

describe('classifyImportFailure', () => {
  it('tells a missing draft, an expired one and a conflict apart', () => {
    expect(classifyImportFailure(apiError(404, 'NOT_FOUND')).kind).toBe('not-found')
    expect(classifyImportFailure(apiError(410, 'IMPORT_EXPIRED')).kind).toBe('expired')
    expect(classifyImportFailure(apiError(409, 'IMPORT_ROW_CONFLICT')).kind).toBe('conflict')
    expect(classifyImportFailure(apiError(409, 'CONFLICT')).kind).toBe('committed')
  })

  it('keeps 401 and 429 as their own states', () => {
    expect(classifyImportFailure(apiError(401, 'UNAUTHORIZED')).kind).toBe('unauthorized')
    expect(classifyImportFailure(apiError(429, 'TOO_MANY_REQUESTS')).kind).toBe('rate-limited')
  })

  it('reads a network failure as its own kind, not as an API error', () => {
    const failure = classifyImportFailure(new TypeError('Failed to fetch'))

    expect(failure.kind).toBe('other')
    expect(failure).toHaveProperty('message', expect.stringContaining('API'))
  })

  it('explains a structured CSV error in words', () => {
    const failure = classifyImportFailure(
      apiError(400, 'IMPORT_INVALID_CSV', { reason: 'INVALID_ENCODING' }),
    )

    expect(failure.kind).toBe('file')
    expect(failure).toHaveProperty('message', expect.stringContaining('UTF-8'))
  })

  it('names the limit that a too-large file broke', () => {
    const failure = classifyImportFailure(
      apiError(413, 'IMPORT_TOO_LARGE', {
        limit: 'ROWS',
        max: LIBRARY_IMPORT_LIMITS.maxDataRows,
        actual: 250,
      }),
    )

    expect(failure).toHaveProperty('message', expect.stringContaining('250'))
  })

  it('falls back to the server message when details do not match the contract', () => {
    const failure = classifyImportFailure(
      apiError(400, 'IMPORT_INVALID_CSV', { reason: 'SOMETHING_NEW' }),
    )

    expect(failure).toEqual({ kind: 'file', message: 'повідомлення IMPORT_INVALID_CSV' })
  })
})

describe('row views over the one cached draft', () => {
  const draft = buildDraft({
    rows: [
      buildRow({ rowNumber: 1, status: 'READY_EXISTING_EDITION', rowVersion: 'v1' }),
      buildRow({ rowNumber: 2, status: 'NEEDS_REVIEW', rowVersion: 'v2' }),
      buildRow({
        rowNumber: 3,
        status: 'INVALID',
        rowVersion: 'v3',
        withValues: false,
        errors: [{ code: 'INVALID_ISBN', field: 'isbn13' }],
      }),
      buildRow({ rowNumber: 4, status: 'SKIPPED', rowVersion: 'v4' }),
    ],
  })

  it('shows every row under "all"', () => {
    expect(selectImportRows(draft, 'all').map((row) => row.rowNumber)).toEqual([1, 2, 3, 4])
  })

  it('groups unresolved and broken rows under "needs attention"', () => {
    expect(selectImportRows(draft, 'attention').map((row) => row.rowNumber)).toEqual([2, 3])
  })

  it('separates ready rows from skipped ones', () => {
    expect(selectImportRows(draft, 'ready').map((row) => row.rowNumber)).toEqual([1])
    expect(selectImportRows(draft, 'skipped').map((row) => row.rowNumber)).toEqual([4])
  })

  it('counts every tab from the server counts, "all" included', () => {
    expect(countImportRows(draft, 'all')).toBe(4)
    expect(countImportRows(draft, 'attention')).toBe(2)
    expect(countImportRows(draft, 'ready')).toBe(1)
    expect(countImportRows(draft, 'skipped')).toBe(1)
  })
})

describe('rowsAwaitingRetry', () => {
  function refusal(details: unknown) {
    return classifyImportFailure(
      new ApiRequestError(409, {
        code: 'IMPORT_NOT_READY',
        message: 'Чернетку імпорту не можна імпортувати',
        details,
      }),
    )
  }

  it.each([
    [
      'EDITION_APPEARED',
      'Видання з таким ISBN уже зʼявилося в каталозі, поки ви готували імпорт. ' +
        'Оновіть ці рядки (кнопка «Оновити з каталогу»), щоб додати примірник до наявного видання.',
    ],
    [
      'WORK_MERGED',
      'Вибраний твір обʼєднали з іншим, поки ви готували імпорт. ' +
        'Оновіть ці рядки (кнопка «Оновити з каталогу») і виберіть твір заново.',
    ],
  ])('називає рівно ту кнопку, яка є на рядку: %s', (reason, message) => {
    // Pinned as exact text, not a fragment: the previous wording sent people to
    // a "Спробувати ще раз" button that does not exist on such a row, and only
    // a full-string check would have caught it.
    expect(refusal({ reason, rowNumbers: [1] })).toMatchObject({ message })
    expect(message).toContain(`«${IMPORT_CATALOG_RETRY_LABEL}»`)
  })

  it('зберігає структуровану причину, а не лише текст', () => {
    const failure = refusal({ reason: 'EDITION_APPEARED', rowNumbers: [2, 5] })

    expect(failure).toMatchObject({ kind: 'not-ready', reason: 'EDITION_APPEARED' })
  })

  it.each(['EDITION_APPEARED', 'WORK_MERGED'])(
    'називає рядки, яким допоможе повторне резолвлення: %s',
    (reason) => {
      expect([...rowsAwaitingRetry(refusal({ reason, rowNumbers: [2, 5] }))]).toEqual([2, 5])
    },
  )

  it.each([
    ['DRAFT_CHANGED', {}],
    ['NOTHING_TO_IMPORT', {}],
    ['ROWS_UNRESOLVED', { rowNumbers: [1] }],
    ['CONFLICTING_EDITION_ROWS', { rowNumbers: [1, 2] }],
    ['WORK_LANG_MISMATCH', { rowNumbers: [1] }],
  ])('не пропонує повтор там, де він нічого не виправить: %s', (reason, rest) => {
    expect(rowsAwaitingRetry(refusal({ reason, ...rest })).size).toBe(0)
  })

  it('тіло, що не відповідає контракту, не вигадує рядків', () => {
    const failure = refusal({ reason: 'НЕВІДОМО' })

    expect(failure).toMatchObject({ kind: 'not-ready', reason: undefined })
    expect(rowsAwaitingRetry(failure).size).toBe(0)
  })

  it('інші збої не пропонують повтор каталогу', () => {
    expect(rowsAwaitingRetry(undefined).size).toBe(0)
    expect(
      rowsAwaitingRetry(
        classifyImportFailure(
          new ApiRequestError(409, { code: 'IMPORT_ROW_CONFLICT', message: 'Рядок змінився' }),
        ),
      ).size,
    ).toBe(0)
  })
})
