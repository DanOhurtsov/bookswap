import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { ExternalSearchResponse } from '@bookswap/shared'
import { SessionGuard } from '../../../auth/session.guard'
import {
  CATALOG_EXTERNAL_SEARCH_RATE_LIMIT,
  CATALOG_EXTERNAL_SEARCH_RATE_WINDOW_MS,
} from '../../../common/rate-limit.config'
import { ExternalSearchQueryDto } from './dto/external-search-query.dto'
import { ExternalSearchService } from './external-search.service'

/**
 * Its own bucket, not the one `/catalog/search/candidates` uses.
 *
 * The neighbouring endpoint scans OUR database with trigrams — expensive for
 * us and for nobody else. This one goes outside and spends somebody else's
 * quota, so the limit is different and tighter. A cache hit counts the same as
 * a miss: otherwise the limit would only guard against repeating one query,
 * while a set of different queries passed unbounded — the same reasoning as in
 * `CATALOG_LOOKUP_RATE_LIMIT`.
 */
const CATALOG_EXTERNAL_SEARCH_LIMIT = {
  lookup: {
    limit: CATALOG_EXTERNAL_SEARCH_RATE_LIMIT,
    ttl: CATALOG_EXTERNAL_SEARCH_RATE_WINDOW_MS,
  },
}

/** §6.3 step 1 (extension): the "found in other catalogs" section of the add-book wizard. */
@Controller('catalog/search')
@UseGuards(SessionGuard)
export class ExternalSearchController {
  constructor(private readonly search: ExternalSearchService) {}

  /**
   * Always 200, even when no source answered: external search is a hint on top
   * of the local one, and its failure must not look like a failure to add a
   * book. What actually happened is visible in `sources`.
   */
  @Get('external')
  @UseGuards(ThrottlerGuard)
  @Throttle(CATALOG_EXTERNAL_SEARCH_LIMIT)
  external(@Query() dto: ExternalSearchQueryDto): Promise<ExternalSearchResponse> {
    return this.search.search(dto.q, dto.page, dto.pageSize)
  }
}
