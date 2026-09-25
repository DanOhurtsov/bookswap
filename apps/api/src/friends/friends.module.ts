import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { FriendsController } from './friends.controller'
import { FriendsService } from './friends.service'

/** §6.2 і §8. `AuthModule` — заради `SessionGuard`, як у `UsersModule`. */
@Module({
  imports: [AuthModule, AccessModule, AnalyticsModule, NotificationsModule],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
