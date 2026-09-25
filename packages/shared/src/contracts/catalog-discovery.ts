import { z } from 'zod'
import { languageCodeSchema } from '../domain/language'
import {
  catalogSearchResultSchema,
  searchPageSchema,
  searchPageSizeSchema,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_PAGE_SIZES,
} from './catalog'
import { networkOwnerSchema } from './network'

export const CATALOG_DISCOVERY_SCOPES = ['CIRCLE', 'ALL'] as const
export const catalogDiscoveryScopeSchema = z.enum(CATALOG_DISCOVERY_SCOPES)
export type CatalogDiscoveryScope = z.infer<typeof catalogDiscoveryScopeSchema>

/** `AVAILABLE` — лише те, що можна позичити зараз; `ANY` — ще й позичене/зарезервоване/недоступне. */
export const CATALOG_DISCOVERY_AVAILABILITY = ['AVAILABLE', 'ANY'] as const
export const catalogDiscoveryAvailabilitySchema = z.enum(CATALOG_DISCOVERY_AVAILABILITY)
export type CatalogDiscoveryAvailability = z.infer<typeof catalogDiscoveryAvailabilitySchema>

export const CATALOG_DISCOVERY_TRANSLATION = ['ANY', 'ORIGINAL', 'TRANSLATED'] as const
export const catalogDiscoveryTranslationSchema = z.enum(CATALOG_DISCOVERY_TRANSLATION)
export type CatalogDiscoveryTranslation = z.infer<typeof catalogDiscoveryTranslationSchema>

export const DISCOVERY_QUERY_MIN = 2
export const DISCOVERY_QUERY_MAX = 200

interface DiscoveryScopeInput {
  scope: CatalogDiscoveryScope
  q?: string | undefined
  availability: CatalogDiscoveryAvailability
  language?: string | undefined
  translation: CatalogDiscoveryTranslation
}

/**
 * Рішення зі scope-узгодження Етапу 9 (варіант A): успадкований режим «Усі»
 * (PR #44) не розвивається. Перегляд без тексту й фільтри працюють лише в колі.
 * Єдине джерело: і zod-схема, і контролер API.
 */
export function discoveryScopeViolation(input: DiscoveryScopeInput): string | null {
  if (input.scope !== 'ALL') return null

  if (input.q === undefined) return 'Для режиму «Усі користувачі» потрібен пошуковий запит'

  if (input.availability !== 'AVAILABLE' || input.language !== undefined) {
    return 'Фільтри доступні лише в режимі «Мої та друзів»'
  }

  if (input.translation !== 'ANY') return 'Фільтри доступні лише в режимі «Мої та друзів»'

  return null
}

export const catalogDiscoveryRequestSchema = z
  .object({
    q: z.preprocess((value) => {
      const text = typeof value === 'string' ? value.trim() : value

      return text === '' ? undefined : text
    }, z.string().trim().min(DISCOVERY_QUERY_MIN).max(DISCOVERY_QUERY_MAX).optional()),
    page: searchPageSchema.default(1),
    pageSize: searchPageSizeSchema.default(DEFAULT_SEARCH_PAGE_SIZE),
    scope: catalogDiscoveryScopeSchema.default('CIRCLE'),
    availability: catalogDiscoveryAvailabilitySchema.default('AVAILABLE'),
    language: languageCodeSchema.optional(),
    translation: catalogDiscoveryTranslationSchema.default('ANY'),
  })
  .superRefine((value, context) => {
    const violation = discoveryScopeViolation(value)

    if (violation !== null) context.addIssue({ code: 'custom', message: violation })
  })

export const catalogDiscoveryLocationSchema = networkOwnerSchema

export const catalogDiscoveryResultSchema = catalogSearchResultSchema.extend({
  locations: z.array(catalogDiscoveryLocationSchema).min(1),
})

export const catalogDiscoveryResponseSchema = z.object({
  results: z.array(catalogDiscoveryResultSchema).max(Math.max(...SEARCH_PAGE_SIZES)),
  page: searchPageSchema,
  pageSize: searchPageSizeSchema,
  scope: catalogDiscoveryScopeSchema,
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type CatalogDiscoveryResponse = z.infer<typeof catalogDiscoveryResponseSchema>
export type CatalogDiscoveryResult = z.infer<typeof catalogDiscoveryResultSchema>
