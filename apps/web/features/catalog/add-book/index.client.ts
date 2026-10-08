'use client'

export { AddBookScreen } from './components/AddBookScreen'

/**
 * Search-result components shared with the catalog discovery page. Discovery
 * shows available user copies; the add-book wizard also searches metadata and
 * external providers. They share presentation and paging where appropriate.
 */
export { ExternalResultCard } from './components/ExternalResultCard'
export { ExternalSearchStatus } from './components/ExternalSearchStatus'
export { LocalResultCard } from './components/LocalResultCard'
export { SearchPagination } from './components/SearchPagination'
export { SearchResultsList, type LocalCardActions } from './components/SearchResultsList'
export { type ExternalSearchState } from './model/external-search-state'
export { searchPageView } from './model/search-page-view'
export { buildUnifiedResults, type LocalCandidate } from './model/unified-results'
export { useExternalSearch } from './model/use-external-search'
