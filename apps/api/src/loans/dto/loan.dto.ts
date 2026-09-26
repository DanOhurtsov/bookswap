import { Transform } from 'class-transformer'
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import {
  LOAN_ACTIONS,
  LOAN_LIMITS,
  LOAN_ROLES,
  LOAN_STATUS,
  type LoanAction,
  type LoanRole,
  type LoanStatus,
} from '@bookswap/shared'
import { IsIsoDate } from '../../common/validators'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/** §8: `POST /loans { copyId, message, proposedDueAt }`. */
export class CreateLoanDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано примірник' })
  @MaxLength(LOAN_LIMITS.idMax)
  copyId!: string

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(LOAN_LIMITS.messageMax)
  message?: string

  @IsOptional()
  @IsIsoDate()
  proposedDueAt?: string
}

/**
 * §8: `PATCH /loans/:id { action, note?, dueAt?, effectiveAt? }`.
 *
 * Один ендпоінт із полем `action` замість окремих маршрутів — так усі переходи
 * проходять крізь одну точку, де живе валідація стейт-машини.
 *
 * Правило «`dueAt` лише разом із `approve`» тут не виражається: `class-validator`
 * не має способу сказати «поле дозволене залежно від значення іншого поля». Воно
 * живе в zod для фронту й перевіряється контролером — та сама навмисна
 * розбіжність механізмів, що вже зафіксована для «оновити хоч щось» у `PATCH /me`.
 */
export class UpdateLoanDto {
  @IsIn(LOAN_ACTIONS, {
    message:
      'Невідома дія: очікується approve, reject, cancel, hand_over, return, mark_lost або recover',
  })
  action!: LoanAction

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(LOAN_LIMITS.noteMax)
  note?: string

  @IsOptional()
  @IsIsoDate()
  dueAt?: string

  /** Stage 10 (10d): фактична дата знахідки; лише з `recover`, не в майбутньому (перевіряє сервіс). */
  @IsOptional()
  @IsIsoDate()
  effectiveAt?: string
}

/** §8: `GET /loans?role=owner|borrower&status=…`. Обидва фільтри незалежні. */
export class LoanQueryDto {
  @IsOptional()
  @IsIn(LOAN_ROLES, { message: 'Невідома роль: очікується owner або borrower' })
  role?: LoanRole

  @IsOptional()
  @IsIn(LOAN_STATUS, { message: 'Невідомий статус позичання' })
  status?: LoanStatus
}
