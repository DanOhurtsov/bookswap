import type { CopyEntryMethod, ExternalSearchResult, WorkDetailResponse } from '@bookswap/shared'
import type { AddBookSearchResult } from '../api/search-add-book'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
import {
  externalSearchBlind,
  externalSearchSettled,
  type ExternalSearchState,
} from '../model/external-search-state'
import { buildUnifiedResults } from '../model/unified-results'
import { ExternalResultCard } from './ExternalResultCard'
import { ExternalSearchStatus } from './ExternalSearchStatus'
import { LocalResultCard } from './LocalResultCard'
import { LookupCard } from './LookupCard'

type SearchResultsProps = {
  result: AddBookSearchResult
  entryMethod: CopyEntryMethod
  external: ExternalSearchState
  onFoundEdition: (selection: ExistingEditionInput) => void
  onFoundWork: (selection: ExistingWorkInput) => void
  onCreateNew: (selection: NewWorkInput) => void
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
 * The results area: ONE list holding our catalog and the external catalogs.
 *
 * It is one list, not a local section followed by an external one, because a
 * person looking for their book is asking a single question and comparing a
 * single set of answers. Two sections made them compare across a heading and
 * work out for themselves which half to trust — while relevance, not origin,
 * is what actually decides whether a row is the book in their hands. Origin is
 * still visible on every card as a badge, and it still decides what the card
 * can do.
 *
 * Local rows appear as soon as the local request answers; external ones join
 * the same list when they arrive (`buildUnifiedResults` simply gets a longer
 * input). Nothing waits: the external state is reported on one line beside the
 * list, never around it.
 *
 * The ISBN path is untouched. An ISBN query does not run an external title
 * search at all (`SearchStep`), so for it this renders exactly what it did
 * before: the looked-up edition, and the offer to create a work from it.
 */
export function SearchResults({
  result,
  entryMethod,
  external,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
  onSelectExternal,
}: SearchResultsProps) {
  const hasExactCatalogEdition =
    result.isbn !== undefined &&
    result.candidates.some((candidate) =>
      candidate.editions.some((edition) => edition.isbn13 === result.isbn),
    )

  const rows = buildUnifiedResults(
    result.query,
    result.candidates,
    external.status === 'ready' ? external.results : [],
  )

  // "Nothing found" may only be said once every source has answered. While one
  // is still being asked, an empty list means "not yet", not "not there".
  const finished = externalSearchSettled(external)

  if (result.candidates.length === 0 && result.lookup !== undefined && rows.length === 0) {
    return (
      <>
        <p className="empty">У каталозі BookSwap цього видання ще немає.</p>
        <ul className="books">
          <LookupCard
            isbn={result.isbn}
            lookup={result.lookup}
            onUse={() => onCreateNew(newWorkInput(result, entryMethod))}
          />
        </ul>
      </>
    )
  }

  return (
    <>
      {result.lookup !== undefined && !hasExactCatalogEdition && (
        <>
          <p className="empty">
            Точне видання знайдено зовні. Перевірте, чи твір уже є у BookSwap.
          </p>
          <ul className="books">
            <LookupCard isbn={result.isbn} lookup={result.lookup} />
          </ul>
        </>
      )}

      {rows.length > 0 && (
        <>
          <p className="lede">Можливо, це одна з цих книжок?</p>
          <ul className="books">
            {rows.map((row) =>
              row.origin === 'LOCAL' ? (
                <LocalResultCard
                  key={row.key}
                  candidate={row.candidate}
                  searchedIsbn={result.isbn}
                  onUseEdition={(editionId) => {
                    onFoundEdition({
                      workId: row.candidate.work.id,
                      title: row.candidate.work.title,
                      editionId,
                      entryMethod,
                    })
                  }}
                  onUseWork={() =>
                    onFoundWork(existingWorkInput(result, row.candidate, entryMethod))
                  }
                />
              ) : (
                <ExternalResultCard
                  key={row.key}
                  result={row.result}
                  onSelect={() => {
                    onSelectExternal(row.result)
                  }}
                />
              ),
            )}
          </ul>
        </>
      )}

      <ExternalSearchStatus state={external} />

      {rows.length === 0 && finished && (
        <>
          <p className="empty">
            {externalSearchBlind(external)
              ? 'У BookSwap нічого схожого немає, а зовнішні каталоги не відповіли — чи є там ця книжка, невідомо.'
              : 'Нічого схожого не знайшлося. Заведемо новий твір.'}
          </p>
          <button type="button" onClick={() => onCreateNew(newWorkInput(result, entryMethod))}>
            Створити новий твір
          </button>
        </>
      )}

      {(rows.length > 0 || !finished) && (
        <p className="form__aside">
          Не знайшли своє видання?{' '}
          <button
            type="button"
            className="button--ghost"
            onClick={() => onCreateNew(newWorkInput(result, entryMethod))}
          >
            Завести новий твір
          </button>
        </p>
      )}
    </>
  )
}
