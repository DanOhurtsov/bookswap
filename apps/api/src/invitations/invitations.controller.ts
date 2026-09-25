import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type {
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  InvitationListResponse,
  ResolveInvitationResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { CreateInvitationDto, InvitationTokenDto } from './dto/invitations.dto'
import { InvitationsService } from './invitations.service'
import type { UserModel } from '../generated/prisma/models'

const CREATE_LIMIT = { auth: { limit: 30, ttl: 60 * 60_000 } }
const TOKEN_LIMIT = { auth: { limit: 30, ttl: 60_000 } }

@Controller('invitations')
@UseGuards(SessionGuard)
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle(CREATE_LIMIT)
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: UserModel,
    @Body() dto: CreateInvitationDto,
  ): Promise<CreateInvitationResponse> {
    const request: CreateInvitationRequest =
      dto.kind === 'LINK' ? { kind: 'LINK' } : { kind: 'EMAIL', email: dto.email ?? '' }

    return this.invitations.create(user, request)
  }

  @Get()
  list(@CurrentUser() user: UserModel): Promise<InvitationListResponse> {
    return this.invitations.list(user.id)
  }

  // Оголошено ДО `:id`: інакше «resolve»/«accept» збіглися б із параметром.
  @Post('resolve')
  @UseGuards(ThrottlerGuard)
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() user: UserModel,
    @Body() dto: InvitationTokenDto,
  ): Promise<ResolveInvitationResponse> {
    return this.invitations.resolve(user.id, dto.token)
  }

  @Post('accept')
  @UseGuards(ThrottlerGuard)
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() user: UserModel,
    @Body() dto: InvitationTokenDto,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept(user.id, dto.token)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@CurrentUser() user: UserModel, @Param('id') id: string): Promise<void> {
    await this.invitations.revoke(user.id, id)
  }
}
