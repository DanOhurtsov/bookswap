import type { AddSearchExternalResponse } from '@bookswap/shared'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { autoExternalView } from './auto-external-view'
import { IDLE_EXTERNAL_SEARCH } from './external-search-state'

const ISBN = '9783161484100'

const response = (
  overrides: Partial<AddSearchExternalResponse> = {},
): AddSearchExternalResponse => ({
  items: [],
  sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
  page: 1,
  pageSize: 8,
  more: 'NO',
  complete: true,
  ...overrides,
})

const ready = (value: AddSearchExternalResponse): KeyedState<AddSearchExternalResponse> => ({
  status: 'ready',
  value,
})

describe('autoExternalView', () => {
  it('is idle below the external threshold, whatever was asked', () => {
    expect(autoExternalView('ко', true, ready(response()))).toBe(IDLE_EXTERNAL_SEARCH)
  })

  it('is idle for a valid ISBN: suggestions never ask the sources by text for it', () => {
    expect(autoExternalView(ISBN, true, ready(response()))).toBe(IDLE_EXTERNAL_SEARCH)
  })

  it('is loading while the text has not been asked yet, even if an answer for another text exists', () => {
    expect(autoExternalView('кобзар', false, ready(response()))).toEqual({ status: 'loading' })
  })

  it.each<KeyedState<AddSearchExternalResponse>>([{ status: 'idle' }, { status: 'loading' }])(
    'is loading while the request is $status',
    (answer) => {
      expect(autoExternalView('кобзар', true, answer)).toEqual({ status: 'loading' })
    },
  )

  it('is failed with the described message when our request failed', () => {
    const error = new Error('boom')

    expect(autoExternalView('кобзар', true, { status: 'error', error })).toEqual({
      status: 'failed',
      message: describeAddBookError(error),
    })
  })

  it('maps a ready answer to the same state a full search produces', () => {
    const value = response({ more: 'UNKNOWN', complete: false, page: 1, pageSize: 8 })

    expect(autoExternalView('кобзар', true, ready(value))).toEqual({
      status: 'ready',
      results: value.items,
      sources: value.sources,
      page: 1,
      pageSize: 8,
      more: 'UNKNOWN',
      complete: false,
    })
  })

  it('carries the spelling suggestion only when the answer has one', () => {
    const suggestion = { forQuery: 'кобзаp', text: 'кобзар' }

    expect(
      autoExternalView('кобзар', true, ready(response({ spellingSuggestion: suggestion }))),
    ).toMatchObject({ status: 'ready', spellingSuggestion: suggestion })
    expect(autoExternalView('кобзар', true, ready(response()))).not.toHaveProperty(
      'spellingSuggestion',
    )
  })
})
