import type {
  ExternalSearchMore,
  ExternalSearchResponse,
  ExternalSearchResult,
  SpellingSuggestion,
} from '@bookswap/shared'

/**
 * State of the "found in other catalogs" section.
 *
 * Four states, not a boolean `loading`. "Searching", "found nothing", "source
 * unavailable" and "have not searched yet" are different facts, and two of them
 * are easy to mistake for a third: an empty list during a failure would read as
 * "no such book" when in truth nobody managed to look. The type keeps them
 * apart so there is nowhere left to confuse them.
 *
 * `failed` is a failure of OUR request (network, 429, 401): the section knows
 * nothing at all. A single source being unavailable is a different matter — it
 * arrives inside a successful answer via `sources`, because the other sources
 * did reply.
 */
export type ExternalSearchState<TResult = ExternalSearchResult> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      results: TResult[]
      sources: ExternalSearchResponse['sources']
      /** Which page these results are, 1-based. */
      page: number
      pageSize: number
      /**
       * Is there a further external record? `YES` is proof, `NO` is "every source
       * that answered is exhausted", `UNKNOWN` is "no proof, streams not
       * exhausted" — never rounded to either of the others.
       */
      more: ExternalSearchMore
      /**
       * Is the page final? `false` means the server ran out of its per-request
       * budget and the hook is still asking for the rest; `results` is then a
       * PARTIAL page and must not be read as the end of the list.
       */
      complete: boolean
      /** Підказка виправлення написання від зовнішньої половини; див. `visibleSpellingSuggestion`. */
      spellingSuggestion?: SpellingSuggestion
    }

export const IDLE_EXTERNAL_SEARCH: ExternalSearchState<never> = { status: 'idle' }

/** Відповідь будь-якої зовнішньої половини списку: записи можуть бути й `ExternalSearchResult`, і змішаними елементами. */
export interface ExternalHalfResponse<TResult> {
  results: TResult[]
  sources: ExternalSearchResponse['sources']
  page: number
  pageSize: number
  more: ExternalSearchMore
  complete: boolean
  spellingSuggestion?: SpellingSuggestion
}

export function externalSearchReady<TResult>(
  response: ExternalHalfResponse<TResult>,
): ExternalSearchState<TResult> {
  return {
    status: 'ready',
    results: response.results,
    sources: response.sources,
    page: response.page,
    pageSize: response.pageSize,
    more: response.more,
    complete: response.complete,
    ...(response.spellingSuggestion === undefined
      ? {}
      : { spellingSuggestion: response.spellingSuggestion }),
  }
}

/**
 * What the external half says about a further page.
 *
 * Only a `ready` answer says anything. While a request is in flight, or after it
 * failed, we know nothing about what lies further — and "we have not looked" must
 * never render as a next page that turns out to be empty, so it reads as `NO`.
 */
export function externalSearchMore(state: ExternalSearchState<unknown>): ExternalSearchMore {
  return state.status === 'ready' ? state.more : 'NO'
}

/**
 * Has the external half of the search finished, one way or another?
 *
 * The empty state depends on this and on nothing else: "nothing found" may only
 * be said once every source has answered or failed AND the page is complete. A
 * page that is short only because the server is still loading blocks is not the
 * end of the list.
 */
export function externalSearchSettled(state: ExternalSearchState<unknown>): boolean {
  if (state.status === 'loading') return false

  return state.status !== 'ready' || state.complete
}

/**
 * Did the external half end up knowing nothing at all?
 *
 * True when our own request failed, or when every source that was asked
 * answered with a status other than `OK`. It separates "the book is not in
 * those catalogs" from "nobody managed to look" — the same distinction the
 * state machine above exists for, at the level of the whole search.
 *
 * An empty `sources` is NOT this case: it means no source was queried, which is
 * a third thing again (an ISBN query never asks them).
 */
export function externalSearchBlind(state: ExternalSearchState<unknown>): boolean {
  if (state.status === 'failed') return true
  if (state.status !== 'ready') return false

  return state.sources.length > 0 && state.sources.every((report) => report.status !== 'OK')
}

/**
 * Яку підказку виправлення показати під полем — і чи показувати взагалі.
 *
 * Локальна половина рішає за нашим каталогом; зовнішня — за каталогом ТА записами джерел разом, тож коли
 * вона відповіла по суті (`sources` не порожній: джерела справді питали) і завершила сторінку, її слово
 * остаточне — у тому числі мовчання, яке гасить локальну підказку при суперечності кандидатів. Поки вона
 * ще чекає, не питалась (ISBN, довгий локальний список) чи відповіла помилкою — лишається локальна.
 *
 * Підказка належить тексту, для якого обчислена: показується лише поки нормалізований текст у полі
 * дорівнює її `forQuery`. Тому зміна чи очищення поля прибирає стару одразу, а запізніла відповідь на
 * попередній текст нічого не виправляє.
 */
export function visibleSpellingSuggestion(
  draft: string,
  local: SpellingSuggestion | undefined,
  external: ExternalSearchState<unknown>,
  normalize: (text: string) => string,
): string | undefined {
  const settled = external.status === 'ready' && external.complete && external.sources.length > 0
  const suggestion = settled ? external.spellingSuggestion : local

  return suggestion !== undefined && draft !== '' && normalize(suggestion.forQuery) === draft
    ? suggestion.text
    : undefined
}
