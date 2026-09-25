import { SEARCH_PAGE_SIZES, type SearchPageSize } from '@bookswap/shared'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { knownPageLinks, type NextPage } from '@/app/lib/search-page'

type SearchPaginationProps = {
  page: number
  pageSize: SearchPageSize
  /** What may honestly be promised about a further page — see `nextPageOf`. */
  next: NextPage
  /** Whether the current page shows anything: only then do the earlier pages provably exist. */
  currentHasRows: boolean
  /** Address of a page; the caller decides the route and what else the address carries. */
  hrefFor: (target: { page: number; pageSize: SearchPageSize }) => string
  onPageSizeChange: (size: SearchPageSize) => void
}

/**
 * Page controls reused by discovery and the add-book result list.
 *
 * Built from the Base UI variant of shadcn's `pagination` (`components/ui`), whose
 * links are `next/link`: pages are addresses, so they can be copied, opened in a
 * new tab, and Back/Forward walk them.
 *
 * **Only pages that are KNOWN to exist get a number**: the first, the current one,
 * its predecessors when it has rows, and the next one only when the server proved
 * it. We do not show a total page count: the add-book external sources do not
 * report one. When there is no proof but the streams are not exhausted
 * (`POSSIBLE`), "Далі" is offered without a number: it leads to a page that may
 * turn out to be the end.
 *
 * On the deepest page (`SEARCH_MAX_PAGE`) no link to a further page is drawn, even
 * when records exist deeper: the server does not know that page.
 *
 * The page size is the number of cards in the caller's result list;
 * changing it returns to page 1 (the caller's handler), keeping the query.
 */
export function SearchPagination({
  page,
  pageSize,
  next,
  currentHasRows,
  hrefFor,
  onPageSizeChange,
}: SearchPaginationProps) {
  const links = knownPageLinks({ page, currentHasRows, next })
  const showNavigation = page > 1 || next !== 'NONE'

  return (
    <div className="search-pagination">
      {showNavigation && (
        <Pagination aria-label="Сторінки результатів">
          <PaginationContent>
            {page > 1 && (
              <PaginationItem>
                <PaginationPrevious rel="prev" href={hrefFor({ page: page - 1, pageSize })} />
              </PaginationItem>
            )}

            {links.map((link, index) =>
              link === 'gap' ? (
                <PaginationItem key={`gap-${String(index)}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={link}>
                  <PaginationLink
                    href={hrefFor({ page: link, pageSize })}
                    isActive={link === page}
                    aria-label={
                      link === page
                        ? `Сторінка ${String(link)}, поточна`
                        : `Сторінка ${String(link)}`
                    }
                  >
                    {link}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}

            {next !== 'NONE' && (
              <PaginationItem>
                <PaginationNext
                  rel="next"
                  href={hrefFor({ page: page + 1, pageSize })}
                  {...(next === 'POSSIBLE'
                    ? { title: 'Наявність наступних результатів ще невідома' }
                    : {})}
                />
              </PaginationItem>
            )}
          </PaginationContent>
        </Pagination>
      )}

      <label className="search-pagination__size">
        Результатів на сторінці
        <select
          value={pageSize}
          onChange={(event) => {
            onPageSizeChange(Number(event.target.value) as SearchPageSize)
          }}
        >
          {SEARCH_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
