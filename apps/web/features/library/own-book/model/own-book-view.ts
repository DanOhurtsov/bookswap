import type { Edition, OwnBookResponse, WorkAuthor } from '@bookswap/shared'
import { CONDITION_LABELS, COPY_STATUS_LABELS, VISIBILITY_LABELS } from '@/app/lib/labels'

export interface OwnBookView {
  title: string
  authors: WorkAuthor[]
  edition: Edition
  /** The general page of the work: the owner's page is one copy, this one is the book. */
  workHref: string
  workId: string
  statusLabel: string
  conditionLabel: string
  visibilityLabel: string
  acquiredLabel: string | null
  /** `null` when the copy is at home: there is nobody to name. */
  holderLabel: string | null
  note: string | null
}

/** `2026-08-15` → `15.08.2026`, without a `Date`: a calendar day has no time zone to get wrong. */
function formatDay(day: string): string {
  const [year, month, date] = day.split('-')

  return `${date ?? ''}.${month ?? ''}.${year ?? ''}`
}

function holderLabelOf({ copy }: OwnBookResponse): string | null {
  if (copy.isHome) return null

  return copy.holder === null ? 'Зараз не вдома' : `Зараз у: ${copy.holder.displayName}`
}

/** Everything the page shows that is not a straight read of the response, decided once. */
export function toOwnBookView(response: OwnBookResponse): OwnBookView {
  const { copy, work, authors, edition } = response

  return {
    title: work.title,
    authors,
    edition,
    workHref: `/works/${encodeURIComponent(work.id)}`,
    workId: work.id,
    statusLabel: COPY_STATUS_LABELS[copy.status],
    conditionLabel: CONDITION_LABELS[copy.condition],
    visibilityLabel: VISIBILITY_LABELS[copy.visibility],
    acquiredLabel: copy.acquiredAt === null ? null : formatDay(copy.acquiredAt),
    holderLabel: holderLabelOf(response),
    note: copy.note,
  }
}
