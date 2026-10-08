import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { AddSearchExternalResponse, AddSearchResponse } from '@bookswap/shared'
import { CurrentUser } from '../../auth/authenticated-request'
import { SessionGuard } from '../../auth/session.guard'
import { CatalogSearchDto } from '../../catalog/dto/catalog.dto'
import {
  CATALOG_EXTERNAL_SEARCH_RATE_LIMIT,
  CATALOG_EXTERNAL_SEARCH_RATE_WINDOW_MS,
} from '../../common/rate-limit.config'
import { AddSearchSuggestDto, AddSearchSuggestExternalDto } from './add-search-suggest.dto'
import { AddSearchService } from './add-search.service'
import type { UserModel } from '../../generated/prisma/models'

/** Перебір бази триграмами — той самий бакет і ліміт, що в `/catalog/search`. */
const LOCAL_SEARCH_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

/** Зовнішні джерела — той самий бакет, що в `/catalog/search/external`. */
const EXTERNAL_SEARCH_LIMIT = {
  lookup: {
    limit: CATALOG_EXTERNAL_SEARCH_RATE_LIMIT,
    ttl: CATALOG_EXTERNAL_SEARCH_RATE_WINDOW_MS,
  },
}

/** Підказки під час введення: частіші за повний пошук, але вужчі за нього на клієнта. */
const SUGGEST_EXTERNAL_LIMIT = { lookup: { limit: 20, ttl: 60_000 } }

/**
 * Пошук для сторінки додавання книжки: одна картка — одне конкретне видання.
 * Два запити — дві половини одного списку; обидві ділять сторінку за довжиною локальної частини.
 */
@Controller()
@UseGuards(SessionGuard)
export class AddSearchController {
  constructor(private readonly addSearch: AddSearchService) {}

  @Get('me/library/add-search')
  @UseGuards(ThrottlerGuard)
  @Throttle(LOCAL_SEARCH_LIMIT)
  search(
    @CurrentUser() user: UserModel,
    @Query() dto: CatalogSearchDto,
  ): Promise<AddSearchResponse> {
    return this.addSearch.search(user.id, dto.q, dto.page, dto.pageSize)
  }

  /** Завжди 200, навіть коли жодне джерело не відповіло: деталі — в `sources`. */
  @Get('me/library/add-search/external')
  @UseGuards(ThrottlerGuard)
  @Throttle(EXTERNAL_SEARCH_LIMIT)
  external(
    @CurrentUser() user: UserModel,
    @Query() dto: CatalogSearchDto,
  ): Promise<AddSearchExternalResponse> {
    return this.addSearch.searchExternal(user.id, dto.q, dto.page, dto.pageSize)
  }

  /**
   * Автопошук під час введення — локальна половина. Фіксований режим (перші
   * `AUTO_SEARCH_RESULT_LIMIT` елементів), тому без `page`/`pageSize`.
   */
  @Get('me/library/add-search/suggest')
  @UseGuards(ThrottlerGuard)
  @Throttle(LOCAL_SEARCH_LIMIT)
  suggest(
    @CurrentUser() user: UserModel,
    @Query() dto: AddSearchSuggestDto,
  ): Promise<AddSearchResponse> {
    return this.addSearch.suggest(user.id, dto.q)
  }

  /**
   * Автопошук — зовнішня половина: один запит до одного джерела, без дочитування (див.
   * `ExternalSearchService.suggest`). Власний, вужчий за повний пошук ліміт на клієнта; це НЕ
   * сумарний бюджет виходу назовні — його тримає `ProviderRateLimiter` на інстанс.
   */
  @Get('me/library/add-search/suggest/external')
  @UseGuards(ThrottlerGuard)
  @Throttle(SUGGEST_EXTERNAL_LIMIT)
  suggestExternal(
    @CurrentUser() user: UserModel,
    @Query() dto: AddSearchSuggestExternalDto,
  ): Promise<AddSearchExternalResponse> {
    return this.addSearch.suggestExternal(user.id, dto.q)
  }
}
