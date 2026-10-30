import { Controller, Get, UseGuards } from '@nestjs/common'
import type { FriendsNewBooksResponse } from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { FriendsNewBooksService } from './friends-new-books.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * BS-147: «Нове в бібліотеках друзів» — `GET /api/v1/me/friends/new-books`.
 *
 * Whose friends — only from the session; a guest gets 401 from `SessionGuard`. No input, as for
 * `GET /me/reading-stats`: a feed of someone else's friends cannot even be asked for. The answer is
 * `friendsNewBooksResponseSchema`: `hasFriends` and up to 12 cards, newest first.
 *
 * Swagger: `@nestjs/swagger` is not a dependency of the app (see `ReadingStatusController`), so the
 * operation is described here and the shared contract holds the shape.
 */
@Controller()
@UseGuards(SessionGuard)
export class FriendsNewBooksController {
  constructor(private readonly newBooks: FriendsNewBooksService) {}

  @Get('me/friends/new-books')
  list(@CurrentUser() user: UserModel): Promise<FriendsNewBooksResponse> {
    return this.newBooks.list(user.id)
  }
}
