import { Transform, Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'
import {
  CATALOG_LIMITS,
  EDITION_FORMAT,
  EDITION_TEXT_KIND,
  type EditionFormat,
  type EditionTextKind,
} from '@bookswap/shared'
import {
  EachAuthorHasOneSource,
  EachAuthorIdExcludesNameLatin,
  IsIsbn13,
  IsLanguageCode,
  IsOptionalNotNull,
} from '../../common/validators'
import { normalizeIsbn, normalizeLanguage, trimmed, WorkAuthorInputDto } from './catalog.dto'

/**
 * Stage 8e-1/8e-2: Nest DTO для `PATCH /works|translations|editions/:id`,
 * parity tested against `workPatchRequestSchema`/`translationPatchRequestSchema`/
 * `editionPatchRequestSchema` (`catalog-correction.dto.spec.ts`).
 *
 * Кожне поле — точна копія відповідного поля з `catalog.dto.ts`, лише
 * необов'язкове. Обов'язково НЕ через `@IsOptional()` там, де в zod-схемі поле
 * лишається не-nullable (title/origLang/authors у Work; translator/lang/
 * sourceLang/isAbridged/hasNotes у Translation; format в Edition) — див.
 * `IsOptionalNotNull` у `common/validators.ts` про те, чому.
 *
 * `PatchWorkDto.authors` додатково несе `@EachAuthorIdExcludesNameLatin()`
 * (Stage 8e-2, R10a PO decision): `authorId` + `nameLatin` разом на одному
 * елементі — 400, навіть якщо `nameLatin: null`. PATCH-only — `WorkAuthorInputDto`
 * сам лишається спільним із `CreateWorkDto` і незмінним.
 */

export class PatchWorkDto {
  @IsOptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано назву' })
  @MaxLength(CATALOG_LIMITS.titleMax)
  title?: string

  /** `null` — мова оригіналу невідома (очищення). */
  @IsOptional()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  origLang?: string | null

  @IsOptional()
  @IsInt()
  @Min(CATALOG_LIMITS.yearMin)
  @Max(CATALOG_LIMITS.yearMax)
  firstPubYear?: number | null

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(CATALOG_LIMITS.descriptionMax)
  description?: string | null

  @IsOptionalNotNull()
  @IsArray()
  @ArrayMinSize(1, { message: 'Потрібен хоча б один автор' })
  @ArrayMaxSize(CATALOG_LIMITS.authorsMax)
  @EachAuthorHasOneSource()
  @EachAuthorIdExcludesNameLatin()
  @ValidateNested({ each: true })
  @Type(() => WorkAuthorInputDto)
  authors?: WorkAuthorInputDto[]

  @IsInt()
  @IsPositive()
  expectedRevision!: number
}

export class PatchTranslationDto {
  @IsOptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано перекладача' })
  @MaxLength(CATALOG_LIMITS.translatorMax)
  translator?: string

  @IsOptionalNotNull()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  lang?: string

  @IsOptionalNotNull()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  sourceLang?: string

  @IsOptional()
  @IsInt()
  @Min(CATALOG_LIMITS.yearMin)
  @Max(CATALOG_LIMITS.yearMax)
  year?: number | null

  @IsOptionalNotNull()
  @IsBoolean()
  isAbridged?: boolean

  @IsOptionalNotNull()
  @IsBoolean()
  hasNotes?: boolean

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(CATALOG_LIMITS.notesMax)
  notes?: string | null

  @IsInt()
  @IsPositive()
  expectedRevision!: number
}

export class PatchEditionDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.idMax)
  translationId?: string | null

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.publisherMax)
  publisher?: string | null

  @IsOptional()
  @IsInt()
  @Min(CATALOG_LIMITS.yearMin)
  @Max(CATALOG_LIMITS.yearMax)
  year?: number | null

  @IsOptional()
  @Transform(normalizeIsbn)
  @IsIsbn13()
  isbn13?: string | null

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CATALOG_LIMITS.pageCountMax)
  pageCount?: number | null

  @IsOptional()
  @IsUrl({}, { message: 'Некоректне посилання' })
  @MaxLength(CATALOG_LIMITS.coverUrlMax)
  coverUrl?: string | null

  /** `null` — формат невідомий (очищення). */
  @IsOptional()
  @IsIn(EDITION_FORMAT, { message: 'Невідомий формат видання' })
  format?: EditionFormat | null

  @IsOptionalNotNull()
  @IsIn(EDITION_TEXT_KIND, { message: 'Невідомий тип тексту видання' })
  textKind?: EditionTextKind

  @IsOptional()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  lang?: string | null

  @IsInt()
  @IsPositive()
  expectedRevision!: number
}
