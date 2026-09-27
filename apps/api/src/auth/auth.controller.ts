import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { AcceptedResponse, SessionResponse } from '@bookswap/shared'
import type { Response } from 'express'
import { toMe } from '../users/user.mapper'
import { AuthService } from './auth.service'
import { CurrentUser, type AuthenticatedRequest } from './authenticated-request'
import { SESSION_COOKIE_NAME } from './auth.constants'
import {
  ConfirmEmailDto,
  ConfirmPasswordResetDto,
  LoginDto,
  RegisterDto,
  RequestPasswordResetDto,
} from './dto/auth.dto'
import { clearSessionCookie, setSessionCookie } from './session.cookie'
import { SessionGuard } from './session.guard'
import type { UserModel } from '../generated/prisma/models'

/**
 * §11 вимагає rate limiting на чутливих ендпоінтах. Ліміти різні за призначенням:
 * підбір пароля треба стримувати жорсткіше, ніж повторний запит листа.
 */
const LOGIN_LIMIT = { auth: { limit: 10, ttl: 15 * 60_000 } }
const REGISTER_LIMIT = { auth: { limit: 5, ttl: 60 * 60_000 } }
const EMAIL_LIMIT = { auth: { limit: 5, ttl: 60 * 60_000 } }
const TOKEN_LIMIT = { auth: { limit: 20, ttl: 60 * 60_000 } }

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production'
  }

  /** Та сама форма для register/login/session/confirm; прапор читає лише сервер. */
  private sessionResponse(user: UserModel): SessionResponse {
    return {
      user: toMe(user),
      features: { guestLoans: this.config.get<boolean>('GUEST_LOANS_ENABLED') === true },
    }
  }

  @Post('register')
  @Throttle(REGISTER_LIMIT)
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const { user, sessionToken } = await this.auth.register(dto)

    setSessionCookie(response, sessionToken, this.isProduction)

    return this.sessionResponse(user)
  }

  @Post('login')
  @Throttle(LOGIN_LIMIT)
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const { user, sessionToken } = await this.auth.login(dto)

    setSessionCookie(response, sessionToken, this.isProduction)

    return this.sessionResponse(user)
  }

  /**
   * Без guard'а навмисно: вийти має вдаватися й тоді, коли сесія вже протухла.
   * Інакше єдиний спосіб позбутися мертвої кукі — чистити її руками в браузері.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token: unknown = request.cookies?.[SESSION_COOKIE_NAME]

    await this.auth.logout(typeof token === 'string' ? token : undefined)

    clearSessionCookie(response, this.isProduction)
  }

  /** Поточна сесія. 401 без неї — цим фронт і відрізняє гостя від залогіненого. */
  @Get('session')
  @UseGuards(SessionGuard)
  session(@CurrentUser() user: UserModel): SessionResponse {
    return this.sessionResponse(user)
  }

  @Post('email-verification')
  @UseGuards(SessionGuard)
  @Throttle(EMAIL_LIMIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async resendEmailVerification(@CurrentUser() user: UserModel): Promise<AcceptedResponse> {
    await this.auth.resendEmailVerification(user)

    return { accepted: true }
  }

  @Post('email-verification/confirm')
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.OK)
  async confirmEmail(@Body() dto: ConfirmEmailDto): Promise<SessionResponse> {
    return this.sessionResponse(await this.auth.confirmEmail(dto.token))
  }

  /**
   * §6.1: відповідь однакова незалежно від того, чи існує акаунт — і код, і тіло.
   * 202 замість 200 чесно каже «прийняв, що буде далі — не твоя справа».
   */
  @Post('password-reset')
  @Throttle(EMAIL_LIMIT)
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordReset(@Body() dto: RequestPasswordResetDto): AcceptedResponse {
    this.auth.requestPasswordReset(dto.email)

    return { accepted: true }
  }

  /** Після зміни пароля розлогінює всюди, включно з поточним браузером. */
  @Post('password-reset/confirm')
  @Throttle(TOKEN_LIMIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(
    @Body() dto: ConfirmPasswordResetDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.confirmPasswordReset(dto)

    clearSessionCookie(response, this.isProduction)
  }
}
