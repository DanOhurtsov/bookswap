import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module'
import { LocalMatchesModule } from './local-matches.module'
import { SearchCandidatesController } from './search-candidates.controller'
import { SearchCandidatesService } from './search-candidates.service'

/**
 * Етап 7c. Імпортується в `CatalogModule` так само, як `LookupModule`
 * (Етап 7b): маршрут `/catalog/search/candidates` — той самий простір
 * `catalog`, що й `CatalogController`.
 *
 * Ранжування бере з `LocalMatchesModule`, а не через імпорт `CatalogModule`:
 * `CatalogModule` уже імпортує цей модуль, і зворотний імпорт означав би цикл.
 */
@Module({
  imports: [AuthModule, LocalMatchesModule],
  controllers: [SearchCandidatesController],
  providers: [SearchCandidatesService],
})
export class SearchCandidatesModule {}
