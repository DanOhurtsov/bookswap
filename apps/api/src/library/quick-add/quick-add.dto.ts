import { Transform, Type } from 'class-transformer'
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import {
  CONDITION,
  COPY_ENTRY_METHOD,
  LIBRARY_LIMITS,
  VISIBILITY,
  quickAddTargetSchema,
  type Condition,
  type CopyEntryMethod,
  type QuickAddTarget,
  type Visibility,
} from '@bookswap/shared'
import { z } from 'zod'
import { IsIsoDate, IsZodSchema } from '../../common/validators'

/**
 * `class-validator`-половина контракту швидкого додавання; zod-половина живе в
 * `packages/shared/src/contracts/quick-add.ts`, а `quick-add.dto.spec.ts` тримає обидві на
 * однакових вироках.
 *
 * `operationId` і `target` перевіряє сама zod-схема (`IsZodSchema`): дискримінована
 * вкладена форма не виражається чесно декораторами, а друга копія її правил розійшлася б.
 */

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

export class QuickAddCopyDto {
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
}

export class QuickAddDto {
  @IsZodSchema(z.uuid(), { message: 'operationId має бути UUID' })
  operationId!: string

  @IsOptional()
  @IsIn(COPY_ENTRY_METHOD, { message: 'Невідомий спосіб додавання примірника' })
  entryMethod?: CopyEntryMethod

  @IsOptional()
  @ValidateNested()
  @Type(() => QuickAddCopyDto)
  copy?: QuickAddCopyDto

  @IsZodSchema(quickAddTargetSchema, { message: 'Некоректна ціль додавання' })
  target!: QuickAddTarget
}
