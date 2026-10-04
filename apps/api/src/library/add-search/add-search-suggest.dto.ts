import { Transform } from 'class-transformer'
import { IsString, MaxLength, MinLength } from 'class-validator'
import {
  AUTO_SEARCH_EXTERNAL_MIN_CHARS,
  AUTO_SEARCH_LOCAL_MIN_CHARS,
  CATALOG_LIMITS,
} from '@bookswap/shared'

/** Trim and fold runs of whitespace: the same text must mean the same query (and cache key) everywhere. */
const normalized = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : value

/**
 * Auto-suggest input: ONE field and nothing else. There is deliberately no `page` or `pageSize` —
 * the suggest endpoints are a fixed, capped mode, and a parameter the client could raise would be a
 * way to ask for the full search through the cheap door. `forbidNonWhitelisted` makes a stray
 * `?pageSize=50` a 400.
 */
export class AddSearchSuggestDto {
  @Transform(normalized)
  @IsString()
  @MinLength(AUTO_SEARCH_LOCAL_MIN_CHARS, { message: 'Мінімум два символи' })
  @MaxLength(CATALOG_LIMITS.queryMax)
  q!: string
}

/** The external half costs somebody else's quota, so it needs one more character than ours. */
export class AddSearchSuggestExternalDto {
  @Transform(normalized)
  @IsString()
  @MinLength(AUTO_SEARCH_EXTERNAL_MIN_CHARS, { message: 'Мінімум три символи' })
  @MaxLength(CATALOG_LIMITS.queryMax)
  q!: string
}
