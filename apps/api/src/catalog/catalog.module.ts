import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CanonicalWorkModule } from './canonical/canonical-work.module'
import { CatalogController } from './catalog.controller'
import { CatalogService } from './catalog.service'
import { LookupModule } from './lookup/lookup.module'
import { ExternalSearchModule } from './search/external/external-search.module'
import { SearchCandidatesModule } from './search/search-candidates.module'
import { TextNormalizer } from './text-normalizer'

/**
 * `TextNormalizer` експортується: `LibraryService` нормалізує ним фільтр `?q=`.
 * Нормалізація мусить лишатися однією на весь застосунок — саме тому вона
 * провайдер, а не функція, яку кожен модуль напише собі сам.
 *
 * `LookupModule` (§6.3, крок 1: автозаповнення за ISBN), `SearchCandidatesModule`
 * (Етап 7c, крок 2: кандидати перед створенням) і `ExternalSearchModule`
 * (пошук за назвою в зовнішніх каталогах) імпортуються тут, а не
 * реєструються окремо в `AppModule`: їхні маршрути — той самий простір
 * `catalog`, що й `CatalogController`.
 */
@Module({
  imports: [
    AuthModule,
    CanonicalWorkModule,
    LookupModule,
    SearchCandidatesModule,
    ExternalSearchModule,
  ],
  controllers: [CatalogController],
  providers: [CatalogService, TextNormalizer],
  exports: [TextNormalizer],
})
export class CatalogModule {}
