import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CanonicalWorkModule } from '../catalog/canonical/canonical-work.module'
import { ReadingStatusController } from './reading-status.controller'
import { ReadingStatusService } from './reading-status.service'

/** Stage 10 (10j.1). `AuthModule` — заради `SessionGuard`, як у `WishlistModule`. */
@Module({
  imports: [AuthModule, CanonicalWorkModule],
  controllers: [ReadingStatusController],
  providers: [ReadingStatusService],
})
export class ReadingStatusModule {}
