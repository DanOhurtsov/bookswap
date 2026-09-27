import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import { ExternalBorrowersController } from './external-borrowers.controller'
import { ExternalBorrowersService } from './external-borrowers.service'

/** Stage 10, крок 10f.2. `AuthModule` — заради `SessionGuard`. */
@Module({
  imports: [AuthModule],
  controllers: [ExternalBorrowersController],
  providers: [ExternalBorrowersService, GuestLoansEnabledGuard],
})
export class ExternalBorrowersModule {}
