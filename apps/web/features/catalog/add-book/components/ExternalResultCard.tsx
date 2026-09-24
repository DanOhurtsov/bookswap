import type { BookLookupSource, ExternalSearchResult } from '@bookswap/shared'
import { ResultCardShell } from './ResultCardShell'

export const SOURCE_LABELS: Record<BookLookupSource, string> = {
  OPEN_LIBRARY: 'Open Library',
  GOOGLE_BOOKS: 'Google Books',
  ISBNDB: 'ISBNdb',
}

type ExternalResultCardProps = {
  result: ExternalSearchResult
  onSelect: () => void
}

/**
 * One candidate from an external catalog, as a row of the shared result list.
 *
 * Shows only what the source actually reported: an empty field is simply
 * absent, with no dashes and no "year unknown". That is not cosmetic — §6.3
 * item 7 forbids replacing an unknown value with something plausible, and an
 * empty line on the card is exactly the visible "unknown".
 *
 * The year is read from different fields depending on `kind`, and the caption
 * differs too. For an edition it is the printing year; for a work it is the
 * FIRST publication year, which says nothing about the specific book on the
 * shelf. Showing them identically would tell a person they hold a first
 * edition.
 *
 * The action differs from a local card's and must keep differing: choosing this
 * record starts a duplicate check and then prefills the creation form, whereas
 * a local card can hand over an edition that already exists.
 */
export function ExternalResultCard({ result, onSelect }: ExternalResultCardProps) {
  return (
    <ResultCardShell
      badge={result.sources.map((source) => SOURCE_LABELS[source]).join(' · ')}
      coverUrl={result.coverUrl}
      coverAlt={`Обкладинка «${result.title}»`}
      title={<span className="book__title">{result.title}</span>}
      authors={result.authors === undefined ? undefined : <span>{result.authors.join(', ')}</span>}
      meta={[
        result.language,
        result.publishedYear === undefined ? undefined : String(result.publishedYear),
        result.publisher,
      ]}
    >
      {/* Not gated on `kind`: after a work record is merged into a single
          printing, an EDITION legitimately carries the work-level year too,
          and it stays a separate line from the printing year above. */}
      {result.firstPublishedYear !== undefined && (
        <span className="book__meta">Уперше видано {result.firstPublishedYear}</span>
      )}

      {result.isbn13 === undefined ? (
        <span className="book__meta">
          {result.kind === 'WORK'
            ? 'Запис про твір — ISBN конкретного видання доведеться вписати вручну'
            : 'Джерело не вказало ISBN'}
        </span>
      ) : (
        <span className="book__meta">ISBN {result.isbn13}</span>
      )}

      {result.pageCount !== undefined && (
        <span className="book__meta">{result.pageCount} стор.</span>
      )}

      <button type="button" onClick={onSelect}>
        Вибрати це видання
      </button>
    </ResultCardShell>
  )
}
