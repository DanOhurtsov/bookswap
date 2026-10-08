import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { quickAddRequestSchema, type QuickAddResponse } from '@bookswap/shared'
import { CurrentUser } from '../../auth/authenticated-request'
import { SessionGuard } from '../../auth/session.guard'
import { QUICK_ADD_RATE_LIMIT, QUICK_ADD_RATE_WINDOW_MS } from '../../common/rate-limit.config'
import { QuickAddDto } from './quick-add.dto'
import { QuickAddService } from './quick-add.service'
import type { UserModel } from '../../generated/prisma/models'

/**
 * `POST /api/v1/me/library/quick-add` — одна серверна операція «додати до бібліотеки».
 *
 * 201 і для першого виконання, і для повтору (`replayed: true`): клієнт показує однаковий
 * успіх. Власник — лише з сесії.
 */
@Controller()
@UseGuards(SessionGuard)
export class QuickAddController {
  constructor(private readonly quickAdd: QuickAddService) {}

  @Post('me/library/quick-add')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ThrottlerGuard)
  @Throttle({ quickAdd: { limit: QUICK_ADD_RATE_LIMIT, ttl: QUICK_ADD_RATE_WINDOW_MS } })
  add(@CurrentUser() user: UserModel, @Body() dto: QuickAddDto): Promise<QuickAddResponse> {
    // DTO вже довів форму; `parse` дає канонічне (обрізані рядки) значення, яке й хешується.
    return this.quickAdd.add(user.id, quickAddRequestSchema.parse(dto))
  }
}
