import { Transform } from 'class-transformer'
import { Equals, IsIn, IsString, MaxLength, MinLength } from 'class-validator'
import {
  GUEST_CONFIRMATION_ACTIONS,
  LOAN_LIMITS,
  type GuestConfirmationAction,
} from '@bookswap/shared'
import { IsIsoDate, IsOptionalNotNull } from '../../common/validators'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/** Stage 10 (10i.1): `POST /guest-loan-confirmations` — ті самі поля, що `POST /loans/guest`. */
export class CreateGuestLoanConfirmationDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано примірник' })
  @MaxLength(LOAN_LIMITS.idMax)
  copyId!: string

  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано контакт' })
  @MaxLength(LOAN_LIMITS.idMax)
  externalBorrowerId!: string

  @IsIsoDate()
  handedAt!: string

  @IsOptionalNotNull()
  @IsIsoDate()
  dueAt?: string
}

/**
 * Stage 10 (10i.1): `PATCH /guest-loan-confirmations/:id`. Правило «`bookIsWithOwner: true` — лише і
 * обов'язково з `cancel_handover`» `class-validator` не виражає, тож його перевіряє контролер (той самий
 * прийом, що для `effectiveAt` у `GuestLoansController`).
 */
export class UpdateGuestLoanConfirmationDto {
  @IsIn(GUEST_CONFIRMATION_ACTIONS, {
    message: 'Невідома дія: очікується cancel_handover або record_owner_statement',
  })
  action!: GuestConfirmationAction

  @IsOptionalNotNull()
  @Equals(true, { message: 'bookIsWithOwner може бути лише true' })
  bookIsWithOwner?: true
}
