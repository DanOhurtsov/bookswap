import { Module } from '@nestjs/common'
import { TextNormalizer } from '../text-normalizer'
import { LocalMatches } from './local-matches.service'

/**
 * Спільна матеріалізація локальних збігів для `/catalog/search`,
 * `/catalog/search/candidates` і `/catalog/search/external`.
 *
 * `TextNormalizer` — без стану (обгортка над глобальним `PrismaService`), тож
 * друга реєстрація тут, як і в `SearchCandidatesModule`, нічого не дублює.
 */
@Module({
  providers: [LocalMatches, TextNormalizer],
  exports: [LocalMatches],
})
export class LocalMatchesModule {}
