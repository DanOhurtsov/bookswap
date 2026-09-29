import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  API_ERROR_CODES,
  type GuestLoanConfirmationListResponse,
  type GuestLoanConfirmationResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import {
  CreateGuestLoanConfirmationDto,
  UpdateGuestLoanConfirmationDto,
} from './dto/guest-loan-confirmation.dto'
import { GuestLoanConfirmationService } from './guest-loan-confirmation.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 10 (10i.1): owner-only ресурс `/api/v1/guest-loan-confirmations`. `GuestLoansEnabledGuard` —
 * першим (T9): вимкнена функція не торкається сесії. Публічних маршрутів гостя тут немає (10i.2).
 */
@Controller('guest-loan-confirmations')
@UseGuards(GuestLoansEnabledGuard, SessionGuard)
export class GuestLoanConfirmationsController {
  constructor(private readonly confirmations: GuestLoanConfirmationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: UserModel,
    @Body() dto: CreateGuestLoanConfirmationDto,
  ): Promise<GuestLoanConfirmationResponse> {
    return this.confirmations.create(user.id, dto)
  }

  @Get()
  list(@CurrentUser() user: UserModel): Promise<GuestLoanConfirmationListResponse> {
    return this.confirmations.list(user.id)
  }

  @Get(':id')
  get(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<GuestLoanConfirmationResponse> {
    return this.confirmations.get(user.id, id)
  }

  @Patch(':id')
  update(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() dto: UpdateGuestLoanConfirmationDto,
  ): Promise<GuestLoanConfirmationResponse> {
    // Правило про пару «дія ↔ заява»: `class-validator` не виражає «поле обов'язкове лише з дією X».
    if (dto.action === 'cancel_handover' && dto.bookIsWithOwner !== true) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Скасування потребує заяви власника: bookIsWithOwner = true',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (dto.action === 'record_owner_statement' && dto.bookIsWithOwner !== undefined) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'bookIsWithOwner можна вказати лише разом із cancel_handover',
        HttpStatus.BAD_REQUEST,
      )
    }

    return this.confirmations.apply(user.id, id, dto)
  }
}
