import { Transform } from 'class-transformer'
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator'
import { PROFILE_LIMITS, VISIBILITY, type Visibility } from '@bookswap/shared'

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/**
 * §6.1: редагувати можна рівно п'ять полів. Email тут немає — його зміна тягне
 * повторне підтвердження і є окремим флоу, а не полем форми профілю.
 *
 * `@IsOptional()` у class-validator пропускає і `undefined`, і `null` — саме те,
 * що потрібно: «не чіпати» і «очистити» — різні наміри, і обидва дозволені для
 * аватарки й біо.
 */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(PROFILE_LIMITS.displayNameMin, { message: 'Імʼя закоротке' })
  @MaxLength(PROFILE_LIMITS.displayNameMax, { message: 'Імʼя задовге' })
  displayName?: string

  @IsOptional()
  @IsUrl({}, { message: 'Некоректне посилання' })
  @MaxLength(PROFILE_LIMITS.avatarUrlMax)
  avatarUrl?: string | null

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
