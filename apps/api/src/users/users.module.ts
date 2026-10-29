import { Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { API_PREFIX } from '@bookswap/shared'
import { AccessModule } from '../access/access.module'
import { AuthModule } from '../auth/auth.module'
import { AvatarController } from './avatar/avatar.controller'
import { AVATAR_STORAGE, type AvatarStorage } from './avatar/avatar-storage'
import { AvatarService } from './avatar/avatar.service'
import { InMemoryAvatarStorage } from './avatar/in-memory-avatar-storage'
import { R2AvatarStorage } from './avatar/r2-avatar-storage'
import { ProfileSummaryService } from './profile-summary/profile-summary.service'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

/**
 * Профіль (`/me`), фото профілю (`/me/avatar`, BS-148), зведення профілю (`/me/profile-summary`,
 * BS-148) і пошук людей (`/users`).
 *
 * `AccessModule` — заради стану звʼязку в результатах пошуку: «додати в друзі» чи
 * «вже друзі» вирішує він, а не фронт.
 *
 * The photo store is picked by `AVATAR_STORAGE`, not by `NODE_ENV` — the same reasoning as
 * `EmailModule`. `env.validation.ts` has already refused `memory` in production and an incomplete
 * set of R2 variables, so the factory only reads what is guaranteed to be there.
 */
@Module({
  imports: [AuthModule, AccessModule],
  controllers: [UsersController, AvatarController],
  providers: [
    UsersService,
    AvatarService,
    ProfileSummaryService,
    {
      provide: AVATAR_STORAGE,
      useFactory: (config: ConfigService): AvatarStorage => {
        const kind = config.get<string>('AVATAR_STORAGE') ?? 'memory'

        new Logger('UsersModule').log(`Сховище фото профілю: ${kind}`)

        if (kind === 'r2') {
          return new R2AvatarStorage({
            accountId: config.getOrThrow<string>('R2_ACCOUNT_ID'),
            accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
            bucket: config.getOrThrow<string>('R2_AVATAR_BUCKET'),
            publicBaseUrl: config.getOrThrow<string>('R2_PUBLIC_BASE_URL'),
          })
        }

        // The address the web app already reaches this API at in development (NEXT_PUBLIC_API_URL).
        // Keys start with `avatars/`, so a photo is served at `/api/v1/avatars/<owner>/<file>`.
        const port = config.getOrThrow<number>('PORT')

        return new InMemoryAvatarStorage(`http://localhost:${String(port)}${API_PREFIX}`)
      },
      inject: [ConfigService],
    },
  ],
})
export class UsersModule {}
