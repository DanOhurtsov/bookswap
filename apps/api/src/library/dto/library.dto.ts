import { Transform } from 'class-transformer'
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import {
  CONDITION,
  COPY_ENTRY_METHOD,
  COPY_STATUS,
  LIBRARY_LIMITS,
  OWNER_COPY_STATUS,
  VISIBILITY,
  type Condition,
  type CopyEntryMethod,
  type CopyStatus,
  type OwnerCopyStatus,
  type Visibility,
} from '@bookswap/shared'
import { IsIsoDate, IsLanguageCode } from '../../common/validators'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

const normalizeLanguage = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

/** §8: `GET /me/library ?status=&lang=&q=`. Усі три фільтри незалежні. */
export class LibraryQueryDto {
  @IsOptional()
  @IsIn(COPY_STATUS, { message: 'Невідомий статус примірника' })
  status?: CopyStatus

  @IsOptional()
  @IsIn(['true', 'false'], { message: 'archived: true або false' })
  archived?: 'true' | 'false'

  @IsOptional()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  lang?: string

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(LIBRARY_LIMITS.queryMin)
  @MaxLength(LIBRARY_LIMITS.queryMax)
  q?: string
}

export class AddCopyDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано видання' })
  @MaxLength(LIBRARY_LIMITS.idMax)
  editionId!: string

  @IsOptional()
  @IsIn(CONDITION, { message: 'Невідомий стан примірника' })
  condition?: Condition

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(LIBRARY_LIMITS.noteMax)
  note?: string | null

  @IsOptional()
  @IsIn(VISIBILITY, { message: 'Невідоме значення видимості' })
  visibility?: Visibility

  @IsOptional()
  @IsIsoDate()
  acquiredAt?: string | null

  @IsOptional()
  @IsIn(COPY_ENTRY_METHOD, { message: 'Невідомий спосіб додавання примірника' })
  entryMethod?: CopyEntryMethod
}

/**
 * §6.4: редагування примірника.
 *
 * `status` приймає лише `AVAILABLE` і `UNAVAILABLE`. `RESERVED` та `LENT_OUT`
 * виникають виключно з переходів §5.1, тож відхиляються тут як **некоректне
 * значення поля**, а не як заборонена дія: клієнт не має права їх надсилати в
 * принципі, і 400 каже це точніше за 409.
 *
 * Вимогу «хоч одне поле» перевіряє контролер — class-validator не виражає
 * правил про набір полів, як і в `PATCH /me`.
 */
export class UpdateCopyDto {
  @IsOptional()
  @IsIn(CONDITION, { message: 'Невідомий стан примірника' })
  condition?: Condition

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(LIBRARY_LIMITS.noteMax)
  note?: string | null

  @IsOptional()
  @IsIn(VISIBILITY, { message: 'Невідоме значення видимості' })
  visibility?: Visibility

  @IsOptional()
  @IsIsoDate()
  acquiredAt?: string | null

  @IsOptional()
  @IsIn(OWNER_COPY_STATUS, {
    message: 'Статусом позичання керує лише запит на позичання — доступні AVAILABLE і UNAVAILABLE',
  })
  status?: OwnerCopyStatus
}
