import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { FriendsModule } from '../friends/friends.module'
import { InvitationsController } from './invitations.controller'
import { InviteEmailHasher } from './invite-email-hasher'
import { InvitationsService } from './invitations.service'

@Module({
  imports: [AnalyticsModule, AuthModule, AccessModule, FriendsModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, InviteEmailHasher],
})
export class InvitationsModule {}
