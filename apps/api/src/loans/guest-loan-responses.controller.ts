import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type {
  AnswerGuestResponseResponse,
  RequestGuestCodeResponse,
  ResolveGuestResponseResponse,
  VerifyGuestCodeResponse,
} from '@bookswap/shared'
import {
  GUEST_CODE_SEND_RATE_LIMIT,
  GUEST_CODE_SEND_RATE_WINDOW_MS,
  GUEST_RESPONSE_RATE_LIMIT,
  GUEST_RESPONSE_RATE_WINDOW_MS,
} from '../common/rate-limit.config'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import {
  AnswerGuestResponseDto,
  GuestResponseTokenDto,
  RequestGuestCodeDto,
  VerifyGuestCodeDto,
} from './dto/guest-loan-response.dto'
import { GuestLoanResponseService } from './guest-loan-response.service'

const RESPONSE_LIMIT = {
  auth: { limit: GUEST_RESPONSE_RATE_LIMIT, ttl: GUEST_RESPONSE_RATE_WINDOW_MS },
}
const CODE_SEND_LIMIT = {
  auth: { limit: GUEST_CODE_SEND_RATE_LIMIT, ttl: GUEST_CODE_SEND_RATE_WINDOW_MS },
}

/**
 * Stage 10 (10i.2): ПУБЛІЧНІ маршрути гостя `/api/v1/guest-loan-responses/*` — без сесії й акаунта.
 * `GuestLoansEnabledGuard` — першим (T9): вимкнена функція відповідає `FEATURE_DISABLED` до throttler'а,
 * handler'а й БД. Доступ дає лише токен посилання (в тілі, а не в path/query — адреси потрапляють у
 * логи проксі). Жодна відповідь не містить email, нікнейма, alias власника чи історії.
 */
@Controller('guest-loan-responses')
@UseGuards(GuestLoansEnabledGuard)
export class GuestLoanResponsesController {
  constructor(private readonly responses: GuestLoanResponseService) {}

  @Post('resolve')
  @UseGuards(ThrottlerGuard)
  @Throttle(RESPONSE_LIMIT)
  @HttpCode(HttpStatus.OK)
  resolve(@Body() dto: GuestResponseTokenDto): Promise<ResolveGuestResponseResponse> {
    return this.responses.resolve(dto.token)
  }

  @Post('code')
  @UseGuards(ThrottlerGuard)
  @Throttle(CODE_SEND_LIMIT)
  @HttpCode(HttpStatus.OK)
  code(@Body() dto: RequestGuestCodeDto): Promise<RequestGuestCodeResponse> {
    return this.responses.requestCode(dto)
  }

  @Post('verify')
  @UseGuards(ThrottlerGuard)
  @Throttle(RESPONSE_LIMIT)
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyGuestCodeDto): Promise<VerifyGuestCodeResponse> {
    return this.responses.verifyCode(dto)
  }

  @Post('answer')
  @UseGuards(ThrottlerGuard)
  @Throttle(RESPONSE_LIMIT)
  @HttpCode(HttpStatus.OK)
  answer(@Body() dto: AnswerGuestResponseDto): Promise<AnswerGuestResponseResponse> {
    return this.responses.answer(dto)
  }
}
