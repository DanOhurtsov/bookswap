import Link from 'next/link'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import type { LocalCandidate } from '../model/unified-results'
import { ResultCardShell } from './ResultCardShell'

type LocalResultCardProps = {
  candidate: LocalCandidate
  /**
   * Where the title leads, when it leads anywhere.
   *
   * The catalog page links to the work; the add-book wizard does not, because
   * navigating away mid-flow would abandon the copy the person came to add.
   */
  href?: string
  /** One extra line of context, e.g. why this work matched the query. */
  note?: string
  searchedIsbn?: string
  /** Offering an existing edition is the catalog's privilege — omitted, no buttons. */
  onUseEdition?: (editionId: string) => void
  onUseWork?: () => void
}

/** The first cover the work has, if any — the list shows the work, not one printing. */
function coverOf(candidate: LocalCandidate): string | undefined {
  return candidate.editions.find((edition) => edition.coverUrl !== null)?.coverUrl ?? undefined
}

/**
 * A work already in BookSwap, as one row of the shared result list.
 *
 * The visual shell is the same as an external candidate's; the actions are not,
 * and that difference is the point. This card can offer the editions the
 * catalog already holds — "this is my edition" creates only a `Copy` (§6.3
 * step 3) — and that is precisely what an external record cannot do.
 *
 * The actions are OPTIONAL because the same card serves two screens. On
 * `/catalog` the answer to "this is my book" is to open the work; inside the
 * add-book wizard it is to claim one of its editions. Same card, same badge,
 * same information in the same places — only what you can do with it differs,
 * which is the one thing that genuinely differs.
 */
export function LocalResultCard({
  candidate,
  href,
  note,
  searchedIsbn,
  onUseEdition,
  onUseWork,
}: LocalResultCardProps) {
  const title = <span className="book__title">{candidate.work.title}</span>

  return (
    <ResultCardShell
      badge="Наш каталог"
      coverUrl={coverOf(candidate)}
      coverAlt={`Обкладинка «${candidate.work.title}»`}
      title={
        href === undefined ? (
          title
        ) : (
          <Link className="book__title" href={href}>
            {candidate.work.title}
          </Link>
        )
      }
      authors={<AuthorLine authors={candidate.authors} />}
      meta={[
        candidate.work.origLang,
        candidate.work.firstPubYear === null
          ? undefined
          : `уперше видано ${String(candidate.work.firstPubYear)}`,
        note,
      ]}
    >
      {candidate.editions.length === 0 ? (
        <p className="empty">Видань ще не додано.</p>
      ) : (
        <ul className="book__editions">
          {candidate.editions.map((edition) => (
            <li key={edition.id}>
              <EditionLine edition={edition} />
              {edition.isbn13 !== null && edition.isbn13 === searchedIsbn && (
                <span className="chip">точний збіг за ISBN</span>
              )}
              {onUseEdition !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    onUseEdition(edition.id)
                  }}
                >
                  Це моє видання
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {onUseWork !== undefined && (
        <button type="button" className="button--ghost" onClick={onUseWork}>
          У мене інше видання цього твору
        </button>
      )}
    </ResultCardShell>
  )
}
