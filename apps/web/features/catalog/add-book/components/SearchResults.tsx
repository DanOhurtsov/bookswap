import type { CopyEntryMethod, WorkDetailResponse } from '@bookswap/shared'
import type { AddBookSearchResult } from '../api/search-add-book'
import type { ExistingEditionInput, ExistingWorkInput, NewWorkInput } from '../model/add-book-step'
import { CandidateCard } from './CandidateCard'
import { LookupCard } from './LookupCard'

type SearchResultsProps = {
  result: AddBookSearchResult
  entryMethod: CopyEntryMethod
  onFoundEdition: (selection: ExistingEditionInput) => void
  onFoundWork: (selection: ExistingWorkInput) => void
  onCreateNew: (selection: NewWorkInput) => void
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

export function SearchResults({
  result,
  entryMethod,
  onFoundEdition,
  onFoundWork,
  onCreateNew,
}: SearchResultsProps) {
  const hasExactCatalogEdition =
    result.isbn !== undefined &&
    result.candidates.some((candidate) =>
      candidate.editions.some((edition) => edition.isbn13 === result.isbn),
    )

  if (result.candidates.length === 0 && result.lookup !== undefined) {
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

  if (result.candidates.length === 0) {
    return (
      <>
        <p className="empty">Нічого схожого не знайшлося. Заведемо новий твір.</p>
        <button type="button" onClick={() => onCreateNew(newWorkInput(result, entryMethod))}>
          Створити новий твір
        </button>
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
      <p className="lede">Можливо, це один із цих творів?</p>
      <ul className="books">
        {result.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.work.id}
            candidate={candidate}
            searchedIsbn={result.isbn}
            onUseEdition={(editionId) => {
              onFoundEdition({
                workId: candidate.work.id,
                title: candidate.work.title,
                editionId,
                entryMethod,
              })
            }}
            onUseWork={() => onFoundWork(existingWorkInput(result, candidate, entryMethod))}
          />
        ))}
      </ul>

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
    </>
  )
}
