import {
  CATALOG_DISCOVERY_AVAILABILITY,
  CATALOG_DISCOVERY_TRANSLATION,
  DEFAULT_SEARCH_PAGE_SIZE,
  type CatalogDiscoveryAvailability,
  type CatalogDiscoveryScope,
  type CatalogDiscoveryTranslation,
} from '@bookswap/shared'
import type { SearchAddress } from './search-page'

/** `language: ''` means «any». */
export interface DiscoveryFilters {
  availability: CatalogDiscoveryAvailability
  language: string
  translation: CatalogDiscoveryTranslation
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  availability: 'AVAILABLE',
  language: '',
  translation: 'ANY',
}

export const DISCOVERY_LANGUAGES = ['uk', 'en', 'pl', 'de', 'fr', 'es', 'it', 'cs'] as const

export const AVAILABILITY_LABELS: Record<CatalogDiscoveryAvailability, string> = {
  AVAILABLE: 'Лише доступні',
  ANY: 'Разом із позиченими',
}

export const TRANSLATION_LABELS: Record<CatalogDiscoveryTranslation, string> = {
  ANY: 'Будь-який',
  ORIGINAL: 'Оригінал',
  TRANSLATED: 'Переклад',
}

function oneOf<T extends string>(
  values: readonly T[],
  raw: string | null,
  fallback: T,
): T | undefined {
  if (raw === null || raw === '') return fallback

  return values.find((value) => value === raw)
}

/** Filters from the address; `valid: false` when something in it is not a filter value. */
export function readDiscoveryFilters(parameters: URLSearchParams): {
  filters: DiscoveryFilters
  valid: boolean
} {
  const availability = oneOf(
    CATALOG_DISCOVERY_AVAILABILITY,
    parameters.get('availability'),
    'AVAILABLE',
  )
  const translation = oneOf(CATALOG_DISCOVERY_TRANSLATION, parameters.get('translation'), 'ANY')
  const rawLanguage = parameters.get('language') ?? ''
  const language = rawLanguage === '' || DISCOVERY_LANGUAGES.some((code) => code === rawLanguage)

  return {
    filters: {
      availability: availability ?? 'AVAILABLE',
      language: language ? rawLanguage : '',
      translation: translation ?? 'ANY',
    },
    valid: availability !== undefined && translation !== undefined && language,
  }
}

/**
 * Canonical `/catalog` address. Defaults are omitted; in the legacy `ALL` scope
 * filters are dropped altogether (the API refuses them there).
 */
export function discoveryHref(
  address: SearchAddress,
  scope: CatalogDiscoveryScope,
  filters: DiscoveryFilters,
): string {
  const parameters = new URLSearchParams()

  if (address.q !== '') parameters.set('q', address.q)
  if (address.page > 1) parameters.set('page', String(address.page))
  if (address.pageSize !== DEFAULT_SEARCH_PAGE_SIZE) {
    parameters.set('pageSize', String(address.pageSize))
  }

  if (scope === 'ALL') {
    parameters.set('scope', 'ALL')
  } else {
    if (filters.availability !== 'AVAILABLE') parameters.set('availability', filters.availability)
    if (filters.language !== '') parameters.set('language', filters.language)
    if (filters.translation !== 'ANY') parameters.set('translation', filters.translation)
  }

  const query = parameters.toString()

  return query === '' ? '/catalog' : `/catalog?${query}`
}

/** API query string for `/catalog/discover`. */
export function discoveryQuery(input: {
  q: string
  page: number
  pageSize: number
  scope: CatalogDiscoveryScope
  filters: DiscoveryFilters
}): string {
  const parameters = new URLSearchParams()

  if (input.q !== '') parameters.set('q', input.q)
  parameters.set('page', String(input.page))
  parameters.set('pageSize', String(input.pageSize))
  parameters.set('scope', input.scope)

  if (input.scope === 'CIRCLE') {
    parameters.set('availability', input.filters.availability)
    if (input.filters.language !== '') parameters.set('language', input.filters.language)
    parameters.set('translation', input.filters.translation)
  }

  return parameters.toString()
}
