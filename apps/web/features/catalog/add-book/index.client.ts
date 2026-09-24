'use client'

export { AddBookWizard } from './components/AddBookWizard'

/**
 * The search-results half of this feature, reused by the catalog page.
 *
 * `/catalog` and `/catalog/new` ask the same question and must answer it the
 * same way, so they share the relevance ordering, the deduplication, the cards
 * and the source status line rather than each growing its own. The catalog page
 * depends on the add-book feature and not the reverse, which matches what the
 * screens do: choosing an external record there is the first step of adding a
 * book here.
 */
export { ExternalResultCard } from './components/ExternalResultCard'
export { ExternalSearchStatus } from './components/ExternalSearchStatus'
export { LocalResultCard } from './components/LocalResultCard'
export { stashExternalSelection } from './model/external-handoff'
export {
  externalSearchBlind,
  externalSearchSettled,
  type ExternalSearchState,
} from './model/external-search-state'
export { buildUnifiedResults, type LocalCandidate } from './model/unified-results'
export { useExternalSearch } from './model/use-external-search'
