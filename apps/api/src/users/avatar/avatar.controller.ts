import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { API_ERROR_CODES, type Me } from '@bookswap/shared'
import { CurrentUser } from '../../auth/authenticated-request'
import { SessionGuard } from '../../auth/session.guard'
import { ApiException } from '../../common/api.exception'
import { AVATAR_STORAGE, type AvatarStorage } from './avatar-storage'
import { AvatarService } from './avatar.service'
import { InMemoryAvatarStorage } from './in-memory-avatar-storage'
import type { UserModel } from '../../generated/prisma/models'

/** Every upload is decoded and re-encoded: a person changes a photo a few times, not dozens. */
const AVATAR_UPLOAD_LIMIT = { auth: { limit: 10, ttl: 60_000 } }

/**
 * BS-148: the profile photo. The body of `POST /me/avatar` is the file itself — raw bytes, read by a
 * parser mounted on this one route with the size limit (`app.setup.ts`), never by the global JSON
 * parser.
 */
@Controller()
export class AvatarController {
  constructor(
    private readonly avatars: AvatarService,
    @Inject(AVATAR_STORAGE) private readonly storage: AvatarStorage,
  ) {}

  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, ThrottlerGuard)
  @Throttle(AVATAR_UPLOAD_LIMIT)
  upload(@CurrentUser() user: UserModel, @Body() body: unknown): Promise<Me> {
    // The raw parser hands over a Buffer for any body; an empty request leaves no Buffer at all,
    // and an empty file is no photo either — `toStoredAvatar` answers 415 for both.
    return this.avatars.upload(user, Buffer.isBuffer(body) ? body : Buffer.alloc(0))
  }

  @Delete('me/avatar')
  @UseGuards(SessionGuard)
  remove(@CurrentUser() user: UserModel): Promise<Me> {
    return this.avatars.remove(user)
  }

  /**
   * `AVATAR_STORAGE=memory` only: the photos this process keeps, at the addresses it gave them. Public,
   * like the R2 bucket it stands in for — an `<img>` on another origin sends no session. With R2 the
   * photos never pass through the API, and this route answers 404.
   */
  @Get('avatars/:owner/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  served(@Param('owner') owner: string, @Param('file') file: string): StreamableFile {
    const stored =
      this.storage instanceof InMemoryAvatarStorage
        ? this.storage.get(`avatars/${owner}/${file}`)
        : undefined

    if (stored === undefined) {
      throw new ApiException(API_ERROR_CODES.NOT_FOUND, 'Фото не знайдено', HttpStatus.NOT_FOUND)
    }

    return new StreamableFile(stored.bytes, { type: stored.contentType })
  }
}
