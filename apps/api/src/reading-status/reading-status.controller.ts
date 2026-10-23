import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import type {
  FriendsReadingResponse,
  ReadingListResponse,
  ReadingStatsResponse,
  ReadingStatusResponse,
  ReadingStatusesResponse,
  SetReadingStatusResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import {
  FriendsReadingQueryDto,
  ReadingListQueryDto,
  ReadingStatusesQueryDto,
  SetReadingStatusDto,
} from './dto/reading-status.dto'
import { ReadingStatusService } from './reading-status.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 10 (10j.1, T13). Усі маршрути приватні й `/me/*`: користувач лише з сесії, параметра `userId`
 * немає (R-8). Статус і `wasBorrowed` не додаються до жодної спільної відповіді. Єдиний виняток — стрічка
 * BS-137 `GET /me/friends/reading`: `READING` поточних друзів того, хто питає, і нічого більше.
 *
 * Swagger: `@nestjs/swagger` не є залежністю застосунку і документ не піднімається (так само, як у
 * `ActivationController`), тож операції описано тут, а форму відповідей тримають shared-контракти.
 */
@Controller()
@UseGuards(SessionGuard)
export class ReadingStatusController {
  constructor(private readonly readingStatus: ReadingStatusService) {}

  @Put('me/reading-statuses/:workId')
  @HttpCode(HttpStatus.OK)
  set(
    @CurrentUser() user: UserModel,
    @Param('workId') workId: string,
    @Body() dto: SetReadingStatusDto,
  ): Promise<SetReadingStatusResponse> {
    return this.readingStatus.set(user.id, workId, dto.status)
  }

  /** BS-140: статуси полиці одним запитом. Статичний шлях, тож з `:workId` нижче не перетинається. */
  @Get('me/reading-statuses')
  getMany(
    @CurrentUser() user: UserModel,
    @Query() query: ReadingStatusesQueryDto,
  ): Promise<ReadingStatusesResponse> {
    return this.readingStatus.getMany(user.id, query.workIds)
  }

  @Get('me/reading-statuses/:workId')
  get(
    @CurrentUser() user: UserModel,
    @Param('workId') workId: string,
  ): Promise<ReadingStatusResponse> {
    return this.readingStatus.get(user.id, workId)
  }

  /**
   * BS-145: лічильники особистих статусів для головної. Входу немає — ні DTO, ні параметрів: користувач
   * лише з сесії, тож запит про чужу статистику неможливо навіть сформулювати.
   */
  @Get('me/reading-stats')
  stats(@CurrentUser() user: UserModel): Promise<ReadingStatsResponse> {
    return this.readingStatus.stats(user.id)
  }

  /**
   * BS-137: «Що читають мої друзі» — `GET /api/v1/me/friends/reading?cursor=&limit=`.
   *
   * Чиї друзі — лише з сесії; гість отримує 401 від `SessionGuard`. Вхід — лише курсор і розмір сторінки
   * (1…48, типово 12); будь-який інший параметр, зокрема `userId`, — 400. Відповідь —
   * `friendsReadingResponseSchema`: `hasFriends` (чи є хоч одна `ACCEPTED`-дружба), `items` (друг як
   * `PublicUser`, твір, автори, `coverUrl`, `updatedAt`; `updatedAt DESC, id DESC`) і `nextCursor`.
   */
  @Get('me/friends/reading')
  friendsReading(
    @CurrentUser() user: UserModel,
    @Query() query: FriendsReadingQueryDto,
  ): Promise<FriendsReadingResponse> {
    return this.readingStatus.friendsReading(user.id, query)
  }

  @Get('me/reading-list')
  list(
    @CurrentUser() user: UserModel,
    @Query() query: ReadingListQueryDto,
  ): Promise<ReadingListResponse> {
    return this.readingStatus.list(user.id, query)
  }
}
