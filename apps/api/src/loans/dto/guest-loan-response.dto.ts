import { Transform } from 'class-transformer'
import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator'
import {
  GUEST_INVITATION_EMAIL_DOMAIN,
  GUEST_RESPONSE_ANSWERS,
  GUEST_RESPONSE_LIMITS,
  PROFILE_LIMITS,
  type GuestResponseAnswer,
} from '@bookswap/shared'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

const GUEST_DOMAIN_PATTERN = new RegExp(
  `@${GUEST_INVITATION_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`,
  'i',
)

const GUEST_DOMAIN_MESSAGE = `Лише синтетичні адреси домену ${GUEST_INVITATION_EMAIL_DOMAIN} (D2 — реальні дані заборонені)`

/** `POST /guest-loan-confirmations/:id/link` (власник): `COPY` або `EMAIL` + адреса доставки. */
export class IssueGuestConfirmationLinkDto {
  @IsIn(['COPY', 'EMAIL'], { message: 'Невідомий спосіб доставки: COPY або EMAIL' })
  delivery!: 'COPY' | 'EMAIL'

  // Адреса доставки — лише для `EMAIL`; для `COPY` її бути не може (перевіряє контролер, як і в 10i.1).
  @ValidateIf((dto: IssueGuestConfirmationLinkDto) => dto.delivery === 'EMAIL')
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Некоректна email-адреса' })
  @MaxLength(PROFILE_LIMITS.emailMax)
  @Matches(GUEST_DOMAIN_PATTERN, { message: GUEST_DOMAIN_MESSAGE })
  email?: string
}

/** Токен — у тілі, а не в path/query: адреси потрапляють у логи проксі. */
export class GuestResponseTokenDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(GUEST_RESPONSE_LIMITS.tokenMax)
  token!: string
}

/** `POST /guest-loan-responses/code`. */
export class RequestGuestCodeDto extends GuestResponseTokenDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Вкажіть нікнейм' })
  @MaxLength(GUEST_RESPONSE_LIMITS.nicknameMax, { message: 'Нікнейм задовгий' })
  nickname!: string

  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Некоректна email-адреса' })
  @MaxLength(PROFILE_LIMITS.emailMax)
  @Matches(GUEST_DOMAIN_PATTERN, { message: GUEST_DOMAIN_MESSAGE })
  email!: string
}

/** `POST /guest-loan-responses/verify`. */
export class VerifyGuestCodeDto extends RequestGuestCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Код — шість цифр' })
  code!: string
}

/** `POST /guest-loan-responses/answer`. */
export class AnswerGuestResponseDto extends RequestGuestCodeDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(GUEST_RESPONSE_LIMITS.tokenMax)
  proof!: string

  @IsIn(GUEST_RESPONSE_ANSWERS, { message: 'Невідома відповідь: очікується RECEIVED або DENIED' })
  answer!: GuestResponseAnswer
}
