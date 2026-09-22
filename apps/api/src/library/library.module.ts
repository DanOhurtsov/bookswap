import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { CatalogModule } from '../catalog/catalog.module'
import { ActivationController } from './activation.controller'
import { ActivationService } from './activation.service'
import { LibraryController } from './library.controller'
import { LibraryService } from './library.service'

/**
 * `CatalogModule` — заради `TextNormalizer`: фільтр `?q=` мусить нормалізуватися
 * так само, як `titleNorm`, інакше пошук у власній бібліотеці й пошук у каталозі
 * поводяться по-різному на тому самому слові.
 */
@Module({
  imports: [AuthModule, AccessModule, AnalyticsModule, CatalogModule],
  controllers: [LibraryController, ActivationController],
  providers: [LibraryService, ActivationService],
})
export class LibraryModule {}
