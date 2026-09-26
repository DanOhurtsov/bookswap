import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { LoanEventService } from './loan-event.service'
import { LoanService } from './loan.service'
import { LoansController } from './loans.controller'

/**
 * `AccessModule` — заради §9: чи ми друзі й чи видно примірник. Власного
 * `findFirst` по `Friendship` тут немає й бути не повинно.
 *
 * `NotificationsModule` — §7.3, правило 1: сповіщення пишеться в тій самій
 * транзакції, що й перехід.
 */
@Module({
  imports: [AuthModule, AccessModule, AnalyticsModule, NotificationsModule],
  controllers: [LoansController],
  providers: [LoanService, LoanEventService],
  exports: [LoanService],
})
export class LoansModule {}
