import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { buildDraft, buildRow } from '../library-import.test-helpers'
import { classifyImportFailure, countImportRows, selectImportRows } from './import-draft-state'

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
