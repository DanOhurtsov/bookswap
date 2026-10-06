import {
  isValidIsbn13,
  type AddSearchExternalItem,
  type AddSearchExternalResponse,
} from '@bookswap/shared'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import type { KeyedState } from '@/app/lib/use-keyed-request'
import { AUTO_EXTERNAL_MIN_CHARS } from './auto-search'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchReady,
  type ExternalSearchState,
} from './external-search-state'

/**
 * The external half of suggestions in the same shape as the full search's, so "nothing found",
 * "waiting" and "source did not answer" are computed by the SAME functions. Below the threshold it
 * is `idle`; while the text has not been asked yet (pause) or the request is in flight it is
 * `loading`: an empty list then means "not yet", not "none".
 */
export function autoExternalView(
  urlQuery: string,
  asked: boolean,
  answer: KeyedState<AddSearchExternalResponse>,
): ExternalSearchState<AddSearchExternalItem> {
  if (urlQuery.length < AUTO_EXTERNAL_MIN_CHARS || isValidIsbn13(urlQuery)) {
    return IDLE_EXTERNAL_SEARCH
  }

  if (!asked || answer.status === 'idle' || answer.status === 'loading') {
    return { status: 'loading' }
  }

  if (answer.status === 'error') {
    return { status: 'failed', message: describeAddBookError(answer.error) }
  }

  return externalSearchReady({
    results: answer.value.items,
    sources: answer.value.sources,
    page: answer.value.page,
    pageSize: answer.value.pageSize,
    more: answer.value.more,
    complete: answer.value.complete,
    ...(answer.value.spellingSuggestion === undefined
      ? {}
      : { spellingSuggestion: answer.value.spellingSuggestion }),
  })
}
