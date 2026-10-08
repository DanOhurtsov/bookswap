import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { AuthModule } from '../auth/auth.module'
import { BACKGROUND_MODE, DEFAULT_BACKGROUND_MODE } from '../common/background'
import { FriendsModule } from '../friends/friends.module'
import { InvitationsController } from './invitations.controller'
import { InviteEmailHashCleanupService } from './invite-email-hash-cleanup.service'
import { InviteEmailHasher } from './invite-email-hasher'
import { InvitationsService } from './invitations.service'

/**
 * `InvitationsService` — exported: Stage 10 (10g) `ExternalBorrowersModule` calls
 * `createGuestEmail` from `/me/external-borrowers/:id/invitation`, reusing the same
 * Invitation infrastructure, limits and analytics fact as Stage 9's own `/invitations`.
 */
@Module({
  imports: [AnalyticsModule, AuthModule, AccessModule, FriendsModule],
  controllers: [InvitationsController],
  providers: [
    InvitationsService,
    InviteEmailHasher,
    InviteEmailHashCleanupService,
    { provide: BACKGROUND_MODE, useValue: DEFAULT_BACKGROUND_MODE },
  ],
  exports: [InvitationsService],
})
export class InvitationsModule {}
