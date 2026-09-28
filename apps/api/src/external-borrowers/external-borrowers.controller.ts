import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type {
  ExternalBorrowerInvitationResponse,
  ExternalBorrowerListResponse,
  ExternalBorrowerResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import { CreateExternalBorrowerInvitationDto } from './dto/external-borrower-invitation.dto'
import { CreateExternalBorrowerDto, UpdateExternalBorrowerDto } from './dto/external-borrower.dto'
import { ExternalBorrowersService } from './external-borrowers.service'
import type { UserModel } from '../generated/prisma/models'

/** Той самий ліміт, що й `POST /invitations` (`InvitationsController.CREATE_LIMIT`, Етап 9). */
const CREATE_INVITATION_LIMIT = { auth: { limit: 30, ttl: 60 * 60_000 } }

/**
 * Stage 10, крок 10f.2. `GuestLoansEnabledGuard` — першим (T9): вимкнена функція
 * відповідає `FEATURE_DISABLED` до сесії, throttler'а, handler'а й БД. `ThrottlerGuard`
 * (10g, `sendInvitation`) стоїть на рівні методу — за клас-рівневими guard'ами він
 * усе одно виконується третім, після `GuestLoansEnabledGuard` і `SessionGuard`.
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

  /** Stage 10 (10f.3, Q3d): дострокова чистка — лише без активної позики й незакритої `LOST`. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@CurrentUser() user: UserModel, @Param('id') id: string): Promise<void> {
    return this.contacts.delete(user.id, id)
  }

  /**
   * Stage 10 (10g, D2): запрошення гостя приєднатися до BookSwap — та сама інфраструктура
   * Етапу 9 (`Invitation`, ліміти, синхронна відправка), лише з D2-обмеженим доменом і
   * owner-only перевіркою контакту. `GuestLoansEnabledGuard` (клас-рівневий, першим) уже
   * закриває цей маршрут при вимкненій функції до сесії й БД.
   */
  @Post(':id/invitation')
  @UseGuards(ThrottlerGuard)
  @Throttle(CREATE_INVITATION_LIMIT)
  @HttpCode(HttpStatus.CREATED)
  sendInvitation(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() dto: CreateExternalBorrowerInvitationDto,
  ): Promise<ExternalBorrowerInvitationResponse> {
    return this.contacts.sendInvitation(user, id, dto.email)
  }
}
