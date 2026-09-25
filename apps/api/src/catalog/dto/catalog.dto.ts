import { Transform, Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'
import {
  AUTHOR_ROLE,
  CATALOG_DISCOVERY_AVAILABILITY,
  CATALOG_DISCOVERY_SCOPES,
  CATALOG_DISCOVERY_TRANSLATION,
  DISCOVERY_QUERY_MAX,
  DISCOVERY_QUERY_MIN,
  CATALOG_LIMITS,
  EDITION_FORMAT,
  normalizeIsbn13,
  WORK_HOLDERS_AVAILABILITY,
  type AuthorRole,
  type CatalogDiscoveryAvailability,
  type CatalogDiscoveryScope,
  type CatalogDiscoveryTranslation,
  type SearchPageSize,
  type EditionFormat,
} from '@bookswap/shared'
import {
  EachAuthorHasOneSource,
  IsIsbn13,
  IsLanguageCode,
  IsOptionalNotNull,
} from '../../common/validators'
import { PageQueryDto, PagedSearchQueryDto } from './paged-search-query.dto'

// Експортовані: `catalog-correction.dto.ts` (PATCH) повторює ці ж перетворення
// на тих самих полях, і саме тому бере їх звідси, а не переписує вдруге.
export const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

// Мова нормалізується так само, як email: « UK » з форми має стати `uk`, а не
// бути відхиленою як невідома.
export const normalizeLanguage = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

// Дефіси й пробіли в ISBN — оформлення; у базу лягають самі цифри.
export const normalizeIsbn = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeIsbn13(value.trim()) : value

/**
 * `q` і `page` цілком успадковані: у `/catalog/search` і
 * `/catalog/search/external` вхід один і той самий, бо це дві половини одного
 * списку на одній адресі.
 */
export class CatalogSearchDto extends PagedSearchQueryDto {}

/** `GET /works/:id/holders`: один переклад (`original` — оригінал) і фільтр доступності. */
export class WorkHoldersQueryDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.idMax)
  translationId?: string

  @IsOptional()
  @IsIn(WORK_HOLDERS_AVAILABILITY)
  availability: (typeof WORK_HOLDERS_AVAILABILITY)[number] = 'ANY'
}

/** The browsing scope is independent of metadata search used by the add-book wizard. */
export class CatalogDiscoveryDto extends PageQueryDto {
  declare pageSize: SearchPageSize

  /** Порожній `?q=` — те саме, що відсутній: перегляд без тексту. */
  @Transform(({ value }: { value: unknown }) => {
    const text = typeof value === 'string' ? value.trim() : value

    return text === '' ? undefined : text
  })
  @IsOptional()
  @IsString()
  @MinLength(DISCOVERY_QUERY_MIN, { message: 'Мінімум два символи' })
  @MaxLength(DISCOVERY_QUERY_MAX)
  q?: string

  @IsOptional()
  @IsIn(CATALOG_DISCOVERY_SCOPES)
  scope: CatalogDiscoveryScope = 'CIRCLE'

  @IsOptional()
  @IsIn(CATALOG_DISCOVERY_AVAILABILITY)
  availability: CatalogDiscoveryAvailability = 'AVAILABLE'

  @IsOptional()
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  language?: string

  @IsOptional()
  @IsIn(CATALOG_DISCOVERY_TRANSLATION)
  translation: CatalogDiscoveryTranslation = 'ANY'
}

/**
 * A Work's author: **either** an existing author's id, **or** a new one's
 * name.
 *
 * The either/or check is `@EachAuthorHasOneSource()` on the array itself —
 * `@IsOptional()` here would mute every other validator on its own property
 * for `null` too, not just `undefined`. `authorId`, `name` and `role` mirror
 * zod (`workAuthorInputObjectSchema`, `packages/shared`): optional but NOT
 * nullable — hence `IsOptionalNotNull` (`common/validators.ts`), not
 * `IsOptional`. `nameLatin` stays `IsOptional`: in zod it's
 * `.nullable().optional()`, `null` being an explicit "clear the
 * transliteration". `nameLatin` only means anything paired with a new
 * `name` — combined with an existing `authorId` it is not, and must not
 * become, a channel to edit that shared `Author` row's transliteration (see
 * `workAuthorInputObjectSchema` in `packages/shared` for the full reasoning).
 */
export class WorkAuthorInputDto {
  @IsOptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.idMax)
  authorId?: string

  @IsOptionalNotNull()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.authorNameMax)
  name?: string

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.authorNameMax)
  nameLatin?: string | null

  @IsOptionalNotNull()
  @IsIn(AUTHOR_ROLE, { message: 'Невідома роль автора' })
  role?: AuthorRole
}

export class CreateWorkDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано назву' })
  @MaxLength(CATALOG_LIMITS.titleMax)
  title!: string

  @Transform(normalizeLanguage)
  @IsLanguageCode()
  origLang!: string

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

  @IsArray()
  @ArrayMinSize(1, { message: 'Потрібен хоча б один автор' })
  @ArrayMaxSize(CATALOG_LIMITS.authorsMax)
  @EachAuthorHasOneSource()
  @ValidateNested({ each: true })
  @Type(() => WorkAuthorInputDto)
  authors!: WorkAuthorInputDto[]
}

export class CreateTranslationDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Не вказано перекладача' })
  @MaxLength(CATALOG_LIMITS.translatorMax)
  translator!: string

  @Transform(normalizeLanguage)
  @IsLanguageCode()
  lang!: string

  /** §10.3: з якої мови перекладали — найсильніший сигнал при cold start. */
  @Transform(normalizeLanguage)
  @IsLanguageCode()
  sourceLang!: string

  @IsOptional()
  @IsInt()
  @Min(CATALOG_LIMITS.yearMin)
  @Max(CATALOG_LIMITS.yearMax)
  year?: number | null

  @IsOptional()
  @IsBoolean()
  isAbridged?: boolean

  @IsOptional()
  @IsBoolean()
  hasNotes?: boolean

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(CATALOG_LIMITS.notesMax)
  notes?: string | null
}

export class CreateEditionDto {
  /** `null` — видання мовою оригіналу (§4.4). */
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

  @IsOptional()
  @IsIn(EDITION_FORMAT, { message: 'Невідомий формат видання' })
  format?: EditionFormat
}
