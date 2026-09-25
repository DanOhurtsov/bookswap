import { Module } from '@nestjs/common'
import { AuthModule } from '../../../auth/auth.module'
import { LocalMatchesModule } from '../local-matches.module'
import { ExternalSearchCache } from './external-search.cache'
import { ExternalSearchController } from './external-search.controller'
import { EXTERNAL_SEARCH_PROVIDERS } from './external-search-provider'
import { ExternalSearchService } from './external-search.service'
import { GoogleBooksSearchProvider } from './google-books-search-provider'
import { OpenLibrarySearchProvider } from './open-library-search-provider'
import { ProviderRateLimiter } from './provider-rate-limiter'

/**
 * Title search across external catalogs (§6.3 extension; see
 * `docs/plan/stage-9-external-title-search.md`).
 *
 * `EXTERNAL_SEARCH_PROVIDERS` is a token holding a LIST of providers, not one:
 * unlike the ISBN cascade (`FallbackBookLookupProvider`, where sources are
 * tried in turn until the first answer), here all of them are queried in
 * parallel — what is needed is not the first match but a combined candidate
 * list. Tests replace the whole list through
 * `overrideProvider(EXTERNAL_SEARCH_PROVIDERS)`, so no real HTTP happens (§11).
 *
 * ISBNdb is absent from the list: its adapter answers about a specific ISBN and
 * has no title search in the existing integration.
 *
 * The cache and the rate limiter are registered here, i.e. one instance per
 * process — which is the point: shared state that restrains our total outbound
 * traffic. That state is lost on restart (see `external-search.cache.ts`).
 */
@Module({
  imports: [AuthModule, LocalMatchesModule],
  controllers: [ExternalSearchController],
  providers: [
    ExternalSearchService,
    ExternalSearchCache,
    ProviderRateLimiter,
    OpenLibrarySearchProvider,
    GoogleBooksSearchProvider,
    {
      provide: EXTERNAL_SEARCH_PROVIDERS,
      inject: [OpenLibrarySearchProvider, GoogleBooksSearchProvider],
      useFactory: (
        openLibrary: OpenLibrarySearchProvider,
        googleBooks: GoogleBooksSearchProvider,
      ) => [openLibrary, googleBooks],
    },
  ],
})
export class ExternalSearchModule {}
