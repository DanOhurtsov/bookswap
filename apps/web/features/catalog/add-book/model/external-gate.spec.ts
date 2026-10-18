import type { AddSearchExternalItem } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { IDLE_EXTERNAL_SEARCH, externalSearchReady } from './external-search-state'
import { externalGateOf, externalHalfOf } from './external-gate'

const ISBN = '9783161484100'

const gate = (query: string, released: string | undefined) =>
  externalGateOf({ query, normalized: query, released })

describe('externalGateOf', () => {
  it('is NONE for a query shorter than a search or an ISBN, whatever was released', () => {
    expect(gate('к', 'к')).toBe('NONE')
    expect(gate(ISBN, ISBN)).toBe('NONE')
  })

  it('is OPEN for the released query, of any searchable length', () => {
    expect(gate('кобзар', 'кобзар')).toBe('OPEN')
    expect(gate('ко', 'ко')).toBe('OPEN')
  })

  it('is WAITING for typed text from 3 characters until its pause releases it', () => {
    expect(gate('коб', undefined)).toBe('WAITING')
    expect(gate('кобзар', 'кобз')).toBe('WAITING')
  })

  it('is HELD for typed text of 2 characters: only an explicit search asks the sources', () => {
    expect(gate('ко', 'кобзар')).toBe('HELD')
  })

  it('compares the normalized text, but measures the executed query', () => {
    expect(
      externalGateOf({ query: 'кобзар  т', normalized: 'кобзар т', released: 'кобзар т' }),
    ).toBe('OPEN')
  })
})

describe('externalHalfOf', () => {
  const page = {
    results: [],
    sources: [{ source: 'GOOGLE_BOOKS' as const, status: 'OK' as const }],
    page: 1,
    pageSize: 10,
    more: 'UNKNOWN' as const,
    complete: false,
  }

  it('is idle when the sources are not asked for this query', () => {
    expect(externalHalfOf('NONE', { status: 'pending' })).toBe(IDLE_EXTERNAL_SEARCH)
    expect(externalHalfOf('HELD', { status: 'success', data: page })).toBe(IDLE_EXTERNAL_SEARCH)
  })

  it('is loading while waiting for the pause or for the answer — "not yet", never "nothing"', () => {
    expect(externalHalfOf('WAITING', { status: 'success', data: page })).toEqual({
      status: 'loading',
    })
    expect(externalHalfOf('OPEN', { status: 'pending' })).toEqual({ status: 'loading' })
  })

  it('is failed with the described message when our request failed', () => {
    const error = new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато' })

    expect(externalHalfOf('OPEN', { status: 'error', error })).toEqual({
      status: 'failed',
      message: describeAddBookError(error),
    })
  })

  describe('a failed re-ask of a page already on hand (TanStack keeps its data)', () => {
    const error = new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато' })
    const row: AddSearchExternalItem = {
      kind: 'EXTERNAL',
      key: 'external:GOOGLE_BOOKS:r-1',
      result: { id: 'GOOGLE_BOOKS:r-1', kind: 'EDITION', sources: ['GOOGLE_BOOKS'], title: 'Три' },
    }

    it('keeps the rows and the promise it had: a failure hides nothing already found', () => {
      const kept = {
        ...page,
        results: [row],
        sources: [
          { source: 'OPEN_LIBRARY' as const, status: 'OK' as const },
          { source: 'GOOGLE_BOOKS' as const, status: 'ERROR' as const },
        ],
        more: 'YES' as const,
        complete: true,
      }

      expect(externalHalfOf('OPEN', { status: 'error', error, data: kept })).toEqual(
        externalSearchReady(kept),
      )
    })

    it('a partial page whose continuation failed is shown as it stands: nothing more is coming', () => {
      expect(
        externalHalfOf('OPEN', { status: 'error', error, data: { ...page, results: [row] } }),
      ).toMatchObject({ status: 'ready', results: [row], more: 'UNKNOWN', complete: true })
    })

    it('with no rows to keep it is the failure, never "nothing found"', () => {
      expect(externalHalfOf('OPEN', { status: 'error', error, data: page })).toEqual({
        status: 'failed',
        message: describeAddBookError(error),
      })
    })
  })

  it('is the page as it is — a partial one stays incomplete', () => {
    expect(externalHalfOf('OPEN', { status: 'success', data: page })).toMatchObject({
      status: 'ready',
      more: 'UNKNOWN',
      complete: false,
    })
  })
})
