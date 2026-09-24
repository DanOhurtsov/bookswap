import { Transform } from 'class-transformer'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { CATALOG_LIMITS } from '@bookswap/shared'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/**
 * The same input as `/catalog/search/candidates`: one "title or ISBN" field.
 * The bounds match deliberately — both requests come from ONE form field, and a
 * divergence would mean the local search accepts a string the external one
 * rejects with a 400.
 *
 * Validated here rather than in the service, for the same reason as
 * `LookupQueryDto`: a too-short query must answer 400 BEFORE any external call.
 */
export class ExternalSearchQueryDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(CATALOG_LIMITS.queryMin, { message: 'Мінімум два символи' })
  @MaxLength(CATALOG_LIMITS.queryMax)
  q!: string
}
