import { applyDecorators } from '@nestjs/common'
import { Transform } from 'class-transformer'
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator'
import {
  HANDLE_RULES,
  LOAN_TERM_OPTIONS,
  PROFILE_LIMITS,
  VISIBILITY,
  type LoanTermDays,
  type Visibility,
} from '@bookswap/shared'

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/** The same normalization as `citySchema`: a blank city is no city. */
const trimmedOrNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() || null : value

const HANDLE_FORMAT_MESSAGE = 'Лише латинські літери, цифри, - та _, від 3 до 30 символів'

/** The same normalization as `handleSchema`: «Danylo» and «danylo» are one nickname. */
const normalizeHandle = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

/** `handleSchema`'s format, applied by class-validator (§11 requires both mechanisms). */
const IsHandle = (): PropertyDecorator =>
  applyDecorators(
    Transform(normalizeHandle),
    IsString(),
    Length(HANDLE_RULES.min, HANDLE_RULES.max, { message: HANDLE_FORMAT_MESSAGE }),
    Matches(HANDLE_RULES.pattern, { message: HANDLE_FORMAT_MESSAGE }),
  )

/**
 * §6.1, BS-148: the fields a profile edit may change. Email is not here — changing it requires
 * re-confirmation and is a flow of its own, not a field of the profile form. Neither is the photo:
 * since BS-148 it changes only through `POST /me/avatar` / `DELETE /me/avatar`, and `avatarUrl` in
 * this body is refused like any unknown field (`forbidNonWhitelisted`).
 *
 * `@IsOptional()` in class-validator lets through both `undefined` and `null` — exactly what is
 * needed: «leave it» and «clear it» are different intents, and both are allowed for the bio and the
 * city. The nickname cannot be cleared: `@ValidateIf` lets only its absence through, so `null` is
 * validated — and refused — like any other value.
 */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(PROFILE_LIMITS.displayNameMin, { message: 'Імʼя закоротке' })
  @MaxLength(PROFILE_LIMITS.displayNameMax, { message: 'Імʼя задовге' })
  displayName?: string

  @ValidateIf((_, value) => value !== undefined)
  @IsHandle()
  handle?: string

  @IsOptional()
  @Transform(trimmedOrNull)
  @IsString()
  @MaxLength(PROFILE_LIMITS.cityMax, { message: 'Назва міста задовга' })
  city?: string | null

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(PROFILE_LIMITS.bioMax, { message: 'Біо задовге' })
  bio?: string | null

  @IsOptional()
  @IsIn(VISIBILITY, { message: 'Невідоме значення видимості' })
  libraryVisibility?: Visibility

  @IsOptional()
  @IsBoolean()
  showHolderNames?: boolean

  // BS-148: lending settings. A switch cannot be cleared, so `null` is validated — and refused.
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  friendsOfFriendsAccess?: boolean

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  loanRequestsPaused?: boolean

  /** `null` clears the default term. */
  @IsOptional()
  @IsIn(LOAN_TERM_OPTIONS, { message: 'Термін — 14, 21 або 30 днів' })
  defaultLoanTermDays?: LoanTermDays | null

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  ownerDueReminders?: boolean
}

/**
 * §6.1: пошук за імʼям — частковий збіг, за email — ТІЛЬКИ точний.
 *
 * `query` is the one field the interface sends: a partial name match, plus an exact address
 * match when the whole value is a valid email. `q` and `email` stay for compatibility. None of
 * them ever matches an address partially — otherwise the endpoint would tell who is registered,
 * letter by letter. That exactly one of the three is present is checked by the controller: it is
 * a rule about the set of fields, not about a field.
 */
export class UserSearchDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(2, { message: 'Мінімум два символи' })
  @MaxLength(PROFILE_LIMITS.emailMax, { message: 'Задовгий запит' })
  query?: string

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(2, { message: 'Мінімум два символи' })
  @MaxLength(PROFILE_LIMITS.displayNameMax)
  q?: string

  @IsOptional()
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Некоректна email-адреса' })
  @MaxLength(PROFILE_LIMITS.emailMax)
  email?: string
}

/** `GET /users/handles/:handle/availability` (BS-148). */
export class HandleParamDto {
  @IsHandle()
  handle!: string
}
