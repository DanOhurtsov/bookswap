import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { SearchCandidatesResponse } from '@bookswap/shared'
import { SessionGuard } from '../../auth/session.guard'
import { SearchCandidatesQueryDto } from './dto/search-candidates-query.dto'
import { SearchCandidatesService } from './search-candidates.service'

/** Перебір бази триграмами дорожчий за звичайний запит — той самий бакет, що й у `/catalog/search`. */
const SEARCH_CANDIDATES_RATE_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

/** §6.3, крок 2: «можливо, це одна з цих?» — перед створенням нового Work/Edition. */
@Controller('catalog/search')
@UseGuards(SessionGuard)
export class SearchCandidatesController {
  constructor(private readonly search: SearchCandidatesService) {}

  @Get('candidates')
  @UseGuards(ThrottlerGuard)
  @Throttle(SEARCH_CANDIDATES_RATE_LIMIT)
  candidates(@Query() dto: SearchCandidatesQueryDto): Promise<SearchCandidatesResponse> {
    return this.search.search(dto.q, dto.page, dto.pageSize)
  }
}
