import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module'
import { CatalogModule } from '../../catalog/catalog.module'
import { LookupModule } from '../../catalog/lookup/lookup.module'
import { LibraryImportCandidateFinder } from './library-import.candidates'
import { LibraryImportController } from './library-import.controller'
import { LibraryImportRepository } from './library-import.repository'
import { LibraryImportResolver } from './library-import.resolver'
import { LibraryImportService } from './library-import.service'

/**
 * Stage 8f-2: CSV import lives in its own module rather than inside
 * `LibraryModule`.
 *
 * `LookupModule` comes in for `LookupService` — the import must reuse the very
 * same ISBN cache as the add-book wizard, not keep a second one — and
 * `CatalogModule` for `TextNormalizer`, so candidate search normalizes titles
 * exactly as `titleNorm` was written (§4.4).
 */
@Module({
  imports: [AuthModule, CatalogModule, LookupModule],
  controllers: [LibraryImportController],
  providers: [
    LibraryImportService,
    LibraryImportRepository,
    LibraryImportResolver,
    LibraryImportCandidateFinder,
  ],
})
export class LibraryImportModule {}
