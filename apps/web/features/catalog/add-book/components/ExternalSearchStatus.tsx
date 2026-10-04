import { externalSearchSettled, type ExternalSearchState } from '../model/external-search-state'
import { searchingStatusClass } from './screen-styles'

type ExternalSearchStatusProps = {
  state: ExternalSearchState<unknown>
  /** Our own half of the list is still loading — it shares this one line. */
  localLoading?: boolean
}

/**
 * The single "still searching" line for the whole list, local and external halves together.
 *
 * Results join the list as they arrive; this says nothing but "still working"
 * and disappears once both halves are final. A source that did not answer is not
 * announced here — the one place that still has to tell "nobody managed to look"
 * from "no such book" is the empty state (`externalSearchBlind`).
 */
export function ExternalSearchStatus({ state, localLoading = false }: ExternalSearchStatusProps) {
  if (!localLoading && externalSearchSettled(state)) return null

  return <p className={searchingStatusClass}>Шукаю…</p>
}
