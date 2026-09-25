import { z } from 'zod'
import {
  catalogSearchResultSchema,
  searchPageSchema,
  searchPageSizeSchema,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_PAGE_SIZES,
} from './catalog'
import { publicUserSchema } from './user'

export const CATALOG_DISCOVERY_SCOPES = ['CIRCLE', 'ALL'] as const
export const catalogDiscoveryScopeSchema = z.enum(CATALOG_DISCOVERY_SCOPES)
export type CatalogDiscoveryScope = z.infer<typeof catalogDiscoveryScopeSchema>

export const catalogDiscoveryRequestSchema = z.object({
  q: z.string().trim().min(2).max(200),
  page: searchPageSchema.default(1),
  pageSize: searchPageSizeSchema.default(DEFAULT_SEARCH_PAGE_SIZE),
  scope: catalogDiscoveryScopeSchema.default('CIRCLE'),
})

export const catalogDiscoveryLocationSchema = z.object({
  owner: publicUserSchema,
  relation: z.enum(['SELF', 'FRIEND', 'OTHER']),
  availableCopies: z.number().int().positive(),
})

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
