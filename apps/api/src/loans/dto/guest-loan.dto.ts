import { Transform } from 'class-transformer'
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator'
import { GUEST_LOAN_ACTIONS, LOAN_LIMITS, type GuestLoanAction } from '@bookswap/shared'
import { IsIsoDate, IsOptionalNotNull } from '../../common/validators'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/**
 * Stage 10 (10f.3): `POST /loans/guest { copyId, externalBorrowerId, handedAt, dueAt? }`.
 *
 * `dueAt` — необов'язковий, але НЕ `null`: `createGuestLoanRequestSchema` (`packages/shared`) описує
 * його як `guestLoanDateSchema.optional()`, без `.nullable()` — «прибрати строк» тут узагалі не
 * означене поняття (це `POST`, не правка наявного запису). `@IsOptionalNotNull()` замість
 * `@IsOptional()`: останній трактує `null` так само, як «не передали», і `null` мовчки дійшов би
 * до `toDueDate` як `Invalid Date`.
 */
export class CreateGuestLoanDto {
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
 * Stage 10 (10f.3): `PATCH /loans/guest/:id { action, effectiveAt? }`.
 *
 * Окремий, вужчий словник дій від `UpdateLoanDto` (`GUEST_LOAN_ACTIONS`): дії request-flow й
 * запису для гостьової позики синтаксично неможливі ще на рівні DTO.
 */
export class UpdateGuestLoanDto {
  @IsIn(GUEST_LOAN_ACTIONS, {
    message: 'Невідома дія: очікується return, mark_lost, recover або close_loss',
  })
  action!: GuestLoanAction

  /**
   * Дата знахідки; лише з `recover` (перевіряє контролер), не в майбутньому (сервіс). Необов'язкова,
   * але НЕ `null` — `updateGuestLoanRequestSchema` не приймає `null` (на відміну від `dueAt` у
   * реєстрованому `amend_record`, де `null` навмисно означає «прибрати строк», Q23 — тут такого
   * поняття немає). `@IsOptionalNotNull()`: без нього `null` дійшов би до `assertRecoveryDate` як
   * `Invalid Date`, а не як 400.
   */
  @IsOptionalNotNull()
  @IsIsoDate()
  effectiveAt?: string
}
