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
  ReadingListResponse,
  ReadingStatusResponse,
  SetReadingStatusResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ReadingListQueryDto, SetReadingStatusDto } from './dto/reading-status.dto'
import { ReadingStatusService } from './reading-status.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 10 (10j.1, T13). Усі маршрути приватні й `/me/*`: користувач лише з сесії, параметра `userId`
 * немає (R-8). Статус і `wasBorrowed` не додаються до жодної спільної відповіді.
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

  @Get('me/reading-statuses/:workId')
  get(
    @CurrentUser() user: UserModel,
    @Param('workId') workId: string,
  ): Promise<ReadingStatusResponse> {
    return this.readingStatus.get(user.id, workId)
  }

  @Get('me/reading-list')
  list(
    @CurrentUser() user: UserModel,
    @Query() query: ReadingListQueryDto,
  ): Promise<ReadingListResponse> {
    return this.readingStatus.list(user.id, query)
  }
}
