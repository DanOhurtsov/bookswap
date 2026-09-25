import type {
  CopyEntryMethod,
  ExternalSearchResult,
  SearchPageSize,
  WorkDetailResponse,
} from '@bookswap/shared'
import type { AddBookSearchResult } from '../api/search-add-book'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
import type { ExternalSearchState } from '../model/external-search-state'
import { searchPageView } from '../model/search-page-view'
import { buildUnifiedResults } from '../model/unified-results'
import { LookupCard } from './LookupCard'
import { SearchPagination } from './SearchPagination'
import { SearchResultsList, type LocalListState } from './SearchResultsList'

type SearchResultsProps = {
  /** The local half's answer; absent while it is still loading or after it failed. */
  result: AddBookSearchResult | undefined
  local: LocalListState
  entryMethod: CopyEntryMethod
  external: ExternalSearchState
  page: number
  pageSize: SearchPageSize
  /** Address of a page of THIS route — the wizard keeps its own parameters in it. */
  hrefFor: (target: { page: number; pageSize: SearchPageSize }) => string
  onPageSizeChange: (size: SearchPageSize) => void
  onFoundEdition: (selection: ExistingEditionInput) => void
  onFoundWork: (selection: ExistingWorkInput) => void
  /** Creating a new work needs the query, which `result` may not carry yet. */
  onCreateNew: (selection: NewWorkInput) => void
  query: string
  onSelectExternal: (result: ExternalSearchResult) => void
}

function newWorkInput(result: AddBookSearchResult, entryMethod: CopyEntryMethod): NewWorkInput {
  return {
    initialTitle: result.lookup?.title ?? result.query,
    entryMethod,
    ...(result.isbn === undefined ? {} : { isbn: result.isbn }),
    ...(result.lookup === undefined ? {} : { lookup: result.lookup }),
  }
}

function existingWorkInput(
  result: AddBookSearchResult,
  candidate: WorkDetailResponse,
  entryMethod: CopyEntryMethod,
): ExistingWorkInput {
  return {
    workId: candidate.work.id,
    title: candidate.work.title,
    existingTranslations: candidate.translations,
    entryMethod,
    ...(result.isbn === undefined ? {} : { isbn: result.isbn }),
    ...(result.lookup === undefined ? {} : { lookup: result.lookup }),
  }
}

/**
 * The results area of the wizard: the SAME shared list and page controls as
 * `/catalog` (`SearchResultsList`, `SearchPagination`), plus what only the
 * wizard has — the exact-ISBN lookup card and the ways to create a new work.
 * What differs from `/catalog` is what happens AFTER a result is chosen: here an
 * existing edition becomes a copy, an existing work continues to translation, an
 * external record starts the duplicate check.
 *
 * Local rows appear as soon as the local request answers; external ones join the
 * same list when they arrive. Nothing waits: the external state is reported on one
 * line beside the list, never around it.
 *
 * The ISBN path is untouched. An ISBN query does not run an external title
 * search at all (`useExternalSearch`), so for it this renders what it always did:
 * the looked-up edition, and the offer to create a work from it.
 */
export function SearchResults({
  result,
  local,
  entryMethod,
  external,
  page,
  pageSize,
  hrefFor,
  onPageSizeChange,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
  query,
  onSelectExternal,
}: SearchResultsProps) {
  const hasExactCatalogEdition =
    result?.isbn !== undefined &&
    result.candidates.some((candidate) =>
      candidate.editions.some((edition) => edition.isbn13 === result.isbn),
    )

  const rows = buildUnifiedResults(
    result?.candidates ?? [],
    external.status === 'ready' ? external.results : [],
  )

  const view = searchPageView({
    page,
    local: { ready: result !== undefined, hasMore: result?.hasMore ?? false },
    rowCount: rows.length,
    external,
  })

  // The query the create form starts from: a lookup title beats the raw input.
  const startNew = (): void => {
    onCreateNew(
      result === undefined
        ? { initialTitle: query, entryMethod }
        : newWorkInput(result, entryMethod),
    )
  }

  if (
    page === 1 &&
    result !== undefined &&
    result.candidates.length === 0 &&
    result.lookup !== undefined &&
    rows.length === 0
  ) {
    return (
      <>
        <p className="empty">У каталозі BookSwap цього видання ще немає.</p>
        <ul className="books">
          <LookupCard isbn={result.isbn} lookup={result.lookup} onUse={startNew} />
        </ul>
      </>
    )
  }

  return (
    <>
      {result?.lookup !== undefined && !hasExactCatalogEdition && (
        <>
          <p className="empty">
            Точне видання знайдено зовні. Перевірте, чи твір уже є у BookSwap.
          </p>
          <ul className="books">
            <LookupCard isbn={result.isbn} lookup={result.lookup} />
          </ul>
        </>
      )}

      {rows.length > 0 && <p className="lede">Можливо, це одна з цих книжок?</p>}

      <SearchResultsList
        rows={rows}
        local={local}
        external={external}
        page={page}
        firstPageHref={hrefFor({ page: 1, pageSize })}
        localCard={(candidate) => ({
          ...(result?.isbn === undefined ? {} : { searchedIsbn: result.isbn }),
          onUseEdition: (editionId) => {
            onFoundEdition({
              workId: candidate.work.id,
              title: candidate.work.title,
              editionId,
              entryMethod,
            })
          },
          onUseWork: () => {
            if (result !== undefined) onFoundWork(existingWorkInput(result, candidate, entryMethod))
          },
        })}
        onSelectExternal={onSelectExternal}
        emptyNotice={({ blind }) => (
          <>
            <p className="empty">
              {blind
                ? 'У BookSwap нічого схожого немає, а зовнішні каталоги не відповіли — чи є там ця книжка, невідомо.'
                : 'Нічого схожого не знайшлося. Заведемо новий твір.'}
            </p>
            <button type="button" onClick={startNew}>
              Створити новий твір
            </button>
          </>
        )}
      />

      {local.status !== 'idle' && (
        <SearchPagination
          page={page}
          pageSize={pageSize}
          next={view.next}
          currentHasRows={view.currentHasRows}
          hrefFor={hrefFor}
          onPageSizeChange={onPageSizeChange}
        />
      )}

      {(rows.length > 0 || !view.finished) && (
        <p className="form__aside">
          Не знайшли своє видання?{' '}
          <button type="button" className="button--ghost" onClick={startNew}>
            Завести новий твір
          </button>
        </p>
      )}
    </>
  )
}
