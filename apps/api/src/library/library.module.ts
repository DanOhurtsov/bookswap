import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { CatalogModule } from '../catalog/catalog.module'
import { LookupModule } from '../catalog/lookup/lookup.module'
import { ExternalSearchModule } from '../catalog/search/external/external-search.module'
import { LocalMatchesModule } from '../catalog/search/local-matches.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { AddSearchController } from './add-search/add-search.controller'
import { AddSearchService } from './add-search/add-search.service'
import { ActivationController } from './activation.controller'
import { ActivationService } from './activation.service'
import { CopyWriter } from './copy-writer'
import { LibraryController } from './library.controller'
import { LibraryService } from './library.service'
import { CatalogChainWriter } from './quick-add/catalog-chain.writer'
import { ExternalEditionResolver } from './quick-add/external-edition.resolver'
import { QuickAddController } from './quick-add/quick-add.controller'
import { QuickAddService } from './quick-add/quick-add.service'

/**
 * `CatalogModule` — заради `TextNormalizer`: фільтр `?q=` мусить нормалізуватися
 * так само, як `titleNorm`, інакше пошук у власній бібліотеці й пошук у каталозі
 * поводяться по-різному на тому самому слові.
 */
@Module({
  imports: [
    AuthModule,
    AccessModule,
    AnalyticsModule,
    CatalogModule,
    LookupModule,
    ExternalSearchModule,
    LocalMatchesModule,
    NotificationsModule,
  ],
  controllers: [LibraryController, QuickAddController, AddSearchController, ActivationController],
  providers: [
    LibraryService,
    QuickAddService,
    ExternalEditionResolver,
    CatalogChainWriter,
    AddSearchService,
    CopyWriter,
    ActivationService,
  ],
})
export class LibraryModule {}
