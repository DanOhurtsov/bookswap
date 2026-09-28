import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import { NotificationsModule } from '../notifications/notifications.module'
import { GuestLoanService } from './guest-loan.service'
import { GuestLoansController } from './guest-loans.controller'
import { LoanEventService } from './loan-event.service'
import { LoanService } from './loan.service'
import { LoansController } from './loans.controller'

/**
 * `AccessModule` — заради §9: чи ми друзі й чи видно примірник. Власного
 * `findFirst` по `Friendship` тут немає й бути не повинно.
 *
 * `NotificationsModule` — §7.3, правило 1: сповіщення пишеться в тій самій
 * транзакції, що й перехід.
 *
 * Stage 10 (10f.3): `GuestLoansController` — **перед** `LoansController` у масиві `controllers`.
 * Це не стиль: `GET /loans/guest` (два сегменти) і `GET /loans/:id` (теж два, але параметр) —
 * той самий рівень вкладеності, тож Express matчить перший зареєстрований шаблон; реєстрація в
 * такому порядку в межах ОДНОГО модуля гарантує, що статичний сегмент іде першим, незалежно від
 * порядку самих модулів у графі `AppModule`.
 */
@Module({
  imports: [AuthModule, AccessModule, AnalyticsModule, NotificationsModule],
  controllers: [GuestLoansController, LoansController],
  providers: [LoanService, LoanEventService, GuestLoanService, GuestLoansEnabledGuard],
  exports: [LoanService],
})
export class LoansModule {}
