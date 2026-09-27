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
import type { ExternalBorrowerListResponse, ExternalBorrowerResponse } from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import { CreateExternalBorrowerDto, UpdateExternalBorrowerDto } from './dto/external-borrower.dto'
import { ExternalBorrowersService } from './external-borrowers.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 10, крок 10f.2. `GuestLoansEnabledGuard` — першим (T9): вимкнена функція
 * відповідає `FEATURE_DISABLED` до сесії, handler'а й БД.
 */
@Controller('me/external-borrowers')
@UseGuards(GuestLoansEnabledGuard, SessionGuard)
export class ExternalBorrowersController {
  constructor(private readonly contacts: ExternalBorrowersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: UserModel,
    @Body() dto: CreateExternalBorrowerDto,
  ): Promise<ExternalBorrowerResponse> {
    return this.contacts.create(user.id, dto.alias)
  }

  @Get()
  list(@CurrentUser() user: UserModel): Promise<ExternalBorrowerListResponse> {
    return this.contacts.list(user.id)
  }

  @Patch(':id')
  update(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() dto: UpdateExternalBorrowerDto,
  ): Promise<ExternalBorrowerResponse> {
    return this.contacts.updateAlias(user.id, id, dto.alias)
  }
}
