import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module'
import { BATCH_BOOK_LOOKUP_PROVIDER } from './batch-book-lookup-provider'
import { BatchedBookLookupProvider } from './batched-book-lookup-provider'
import { BOOK_LOOKUP_PROVIDER } from './book-lookup-provider'
import { FallbackBookLookupProvider } from './fallback-book-lookup-provider'
import { GoogleBooksLookupProvider } from './google-books-lookup-provider'
import { IsbnDbLookupProvider } from './isbndb-lookup-provider'
import { LookupController } from './lookup.controller'
import { LookupService } from './lookup.service'
import { OpenLibraryLookupProvider } from './open-library-lookup-provider'

/**
 * §6.3, крок 1: автозаповнення форми додавання книги за ISBN.
 *
 * `BOOK_LOOKUP_PROVIDER` — DI-токен, а не пряма ін'єкція `OpenLibraryLookupProvider`
 * у `LookupService`: тести підміняють його фейком через
 * `overrideProvider(BOOK_LOOKUP_PROVIDER)` (§11 — жодного реального HTTP у
 * тестах), не чіпаючи ні сервіс, ні контролер.
 */
@Module({
  imports: [AuthModule],
  controllers: [LookupController],
  providers: [
    LookupService,
    OpenLibraryLookupProvider,
    GoogleBooksLookupProvider,
    IsbnDbLookupProvider,
    FallbackBookLookupProvider,
    BatchedBookLookupProvider,
    { provide: BOOK_LOOKUP_PROVIDER, useExisting: FallbackBookLookupProvider },
    // Stage 8f-2, R7: a second token, not a second implementation of the first.
    // Batch resolution composes the providers differently (see
    // `BatchedBookLookupProvider`), and tests fake it the same way — by token.
    { provide: BATCH_BOOK_LOOKUP_PROVIDER, useExisting: BatchedBookLookupProvider },
  ],
  exports: [LookupService],
})
export class LookupModule {}
