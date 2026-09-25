import { Transform } from 'class-transformer'
import { IsEmail, IsIn, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator'
import { INVITATION_KINDS, INVITATION_TOKEN_MAX, PROFILE_LIMITS } from '@bookswap/shared'
import type { InvitationKind } from '@bookswap/shared'

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/** `POST /invitations`: `{ kind: 'LINK' }` або `{ kind: 'EMAIL', email }`. */
export class CreateInvitationDto {
  @IsIn(INVITATION_KINDS, { message: 'Невідомий вид запрошення' })
  kind!: InvitationKind

  @ValidateIf((dto: CreateInvitationDto) => dto.kind === 'EMAIL')
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Некоректна email-адреса' })
  @MaxLength(PROFILE_LIMITS.emailMax)
  email?: string
}

/** Токен — у тілі, а не в query: адреси потрапляють у логи проксі. */
export class InvitationTokenDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(INVITATION_TOKEN_MAX)
  token!: string
}
