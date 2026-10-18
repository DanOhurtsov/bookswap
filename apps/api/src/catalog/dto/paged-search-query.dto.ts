import { applyDecorators } from '@nestjs/common'
import { Transform, Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'
import {
  CATALOG_LIMITS,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  SEARCH_PAGE_SIZES,
} from '@bookswap/shared'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/**
 * How many CARDS the shared list shows per page, whichever source they come
 * from. Anything outside {@link SEARCH_PAGE_SIZES} is a 400 for the same reason
 * as a malformed `page`: the address must mean what it says. One definition for
 * every search input, so no two halves of one list disagree about it.
 */
export function SearchPageSizeField(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsInt({ message: 'Розмір сторінки має бути цілим' }),
    IsIn(SEARCH_PAGE_SIZES, {
      message: `Розмір сторінки — один із ${SEARCH_PAGE_SIZES.join(', ')}`,
    }),
  )
}

/** The search text — one field for a title, an author or an ISBN. */
export function SearchTextField(): PropertyDecorator {
  return applyDecorators(
    Transform(trimmed),
    IsString(),
    MinLength(CATALOG_LIMITS.queryMin, { message: 'Мінімум два символи' }),
    MaxLength(CATALOG_LIMITS.queryMax),
  )
}

/**
 * The page number alone: the base of every paged input, whatever its page size
 * means when it is absent.
 *
 * Validated in the DTO rather than in a service, for the same reason as
 * `LookupQueryDto`: a bad page or a too-short query must answer 400 BEFORE any
 * database scan or outbound call.
 */
export class PageNumberQueryDto {
  /**
   * 1-based, and an absent `page` means the first one — an address without it is
   * a normal address, not a malformed one.
   *
   * A malformed page (`?page=abc`, `?page=0`, `?page=999`) is a 400 and NOT
   * silently rounded to 1. Quietly serving a different page than the address
   * names would make the back button take the person somewhere they never were.
   *
   * `@Type` is required: implicit conversion is off globally (`app.setup.ts`),
   * and a query parameter arrives as a string. `Number('abc')` is `NaN`, which
   * `@IsInt` rejects.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Номер сторінки має бути цілим' })
  @Min(1, { message: 'Сторінки нумеруються з одиниці' })
  @Max(SEARCH_MAX_PAGE)
  page: number = 1
}

/** A page of the shared list: an absent `pageSize` is the default one. */
export class PageQueryDto extends PageNumberQueryDto {
  @SearchPageSizeField()
  pageSize: number = DEFAULT_SEARCH_PAGE_SIZE
}

/**
 * One search query, one page number and one page size — the input of the
 * halves of the shared list (`/catalog/search`, `/catalog/search/external`;
 * `/catalog/search/candidates` takes the same fields, see its DTO).
 *
 * A single class rather than two identical ones, because there is a single form
 * field and a single set of page controls on screen. If `/catalog/search` and
 * `/catalog/search/external` disagreed about what `q` or `page` may be, one half
 * of one list would answer 400 while the other answered 200 — for the same
 * address the user is looking at.
 */
export class PagedSearchQueryDto extends PageQueryDto {
  @SearchTextField()
  q!: string
}
