import { Module } from '@nestjs/common'
import { AnalyticsModule } from '../../analytics/analytics.module'
import { AuthModule } from '../../auth/auth.module'
import { CatalogModule } from '../../catalog/catalog.module'
import { LookupModule } from '../../catalog/lookup/lookup.module'
import { LibraryImportCandidateFinder } from './library-import.candidates'
import { LibraryImportController } from './library-import.controller'
import { LibraryImportRepository } from './library-import.repository'
import { LibraryImportResolver } from './library-import.resolver'
import { LibraryImportService } from './library-import.service'
import { LibraryImportWriter } from './library-import.writer'

/**
 * Stage 8f-2: CSV import lives in its own module rather than inside
 * `LibraryModule`.
 *
 * `LookupModule` comes in for `LookupService` — the import must reuse the very
 * same ISBN cache as the add-book wizard, not keep a second one — and
 * `CatalogModule` for `TextNormalizer`, so candidate search normalizes titles
 * exactly as `titleNorm` was written (§4.4) — and, from 8g, so a committed
 * import writes `titleNorm`/`nameNorm` by that same rule.
 *
 * `AnalyticsModule` arrives with 8g: the commit records `BOOK_ADDED/CSV` itself
 * after its transaction, rather than going through `POST /me/library` per row
 * (R3).
 */
@Module({
  imports: [AnalyticsModule, AuthModule, CatalogModule, LookupModule],
  controllers: [LibraryImportController],
  providers: [
    LibraryImportService,
    LibraryImportRepository,
    LibraryImportResolver,
    LibraryImportCandidateFinder,
    LibraryImportWriter,
  ],
})
export class LibraryImportModule {}
