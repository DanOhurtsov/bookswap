import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { AnalyticsService } from './analytics.service'
import { FunnelReportService } from './funnel-report.service'
import { NetworkActivationService } from './network-activation.service'

/**
 * docs/plan/stage-8-activation.md — Stage 8a product analytics storage and service.
 *
 * `PrismaModule` імпортується явно, хоч він `@Global` (`prisma/prisma.module.ts`)
 * і `PrismaService` був би доступний і без цього: залежність від Prisma тут не
 * випадкова, а те, чому цей модуль взагалі існує, і явний `imports` документує
 * це прямо в модулі, а не лишає читача здогадуватися по глобальності.
 *
 * There is intentionally no controller, endpoint, job, or timer (§7). Domain services
 * inject `AnalyticsService` only at approved after-commit mutation points.
 */
@Module({
  imports: [PrismaModule],
  providers: [AnalyticsService, FunnelReportService, NetworkActivationService],
  exports: [AnalyticsService, FunnelReportService, NetworkActivationService],
})
export class AnalyticsModule {}
