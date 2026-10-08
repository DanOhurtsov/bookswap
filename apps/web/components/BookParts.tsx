'use client'

import Link from 'next/link'
import type { Edition, Work, WorkAuthor } from '@bookswap/shared'
import { AUTHOR_ROLE_LABELS, EDITION_FORMAT_LABELS } from '@/app/lib/labels'

function AuthorLine({ authors }: { authors: WorkAuthor[] }) {
  if (authors.length === 0) return <span className="book__meta">Автора не вказано</span>

  return (
    <span className="book__meta">
      {authors
        .map((author) =>
          author.role === 'AUTHOR'
            ? author.name
            : `${author.name} (${AUTHOR_ROLE_LABELS[author.role]})`,
        )
        .join(', ')}
    </span>
  )
}

function WorkTitle({ work, authors }: { work: Work; authors: WorkAuthor[] }) {
  return (
    <>
      <Link className="book__title" href={`/works/${work.id}`}>
        {work.title}
      </Link>
      <AuthorLine authors={authors} />
      {work.firstPubYear !== null && (
        <span className="book__meta">Уперше видано {work.firstPubYear}</span>
      )}
    </>
  )
}

/**
 * Рядок видання. `lang` і `translator` рахує сервер, і фронт цієї умови не повторює. Невідомі
 * мова чи формат (`null`) не показуються взагалі: порожнє місце чесніше за вигадане значення.
 */
function EditionLine({ edition }: { edition: Edition }) {
  const parts = [
    edition.publisher,
    edition.year === null ? null : String(edition.year),
    edition.lang,
    edition.format === null ? null : EDITION_FORMAT_LABELS[edition.format],
    edition.pageCount === null ? null : `${String(edition.pageCount)} с.`,
  ].filter((part): part is string => part !== null && part !== '')

  return (
    <span className="book__meta">
      {parts.join(' · ')}
      {edition.translator !== null && (
        <>
          {' · '}
          переклад: {edition.translator}
        </>
      )}
      {edition.isbn13 !== null && <> · ISBN {edition.isbn13}</>}
    </span>
  )
}

function Chip({ children }: { children: string }) {
  return <span className="chip">{children}</span>
}

export { AuthorLine, WorkTitle, EditionLine, Chip }
