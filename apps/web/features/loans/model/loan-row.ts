import type { Edition, EditionFormat, WorkAuthor } from '@bookswap/shared'
import { countNoun } from '@/app/lib/time-ago'
import type { LoansFilters } from './loans-address'
import {
  badgeToneOf,
  shownStatusLabel,
  statusExplanationOf,
  type BadgeTone,
  type ShownStatus,
} from './loan-status'

/**
 * BS-153: one row of «Позичання» — a current loan or a history record — already decided, so the row
 * component only draws it. Both tabs build rows of this one shape and pass them through `toListView`,
 * so search, the status filter, the count and the empty states mean the same everywhere.
 */
export type LoanRowView = {
  /** Unique across the list; a history record without a loan id has its own (BS-142). */
  key: string
  /**
   * Where the row leads: the loan on `/loans`, where its actions are — or, for an anonymous guest
   * record, which has no loan id to open, the copy's history (§6.6).
   */
  href: string
  /** What following the row does, for the end of its accessible name. */
  action: string
  /** Picks the drawn cover's colours: the work, as on every canvas shelf. */
  bookId: string
  title: string
  /** «Авторка, Автор»; empty when the work has none. */
  authors: string
  /** «Мʼяка обкладинка · 2021»; empty when neither is known. */
  edition: string
  coverUrl: string | null
  /** The other side. `name: null` — a guest record, which never carries a name (§6.6). */
  person: { name: string | null; avatarUrl: string | null }
  /** «Я позичаю», «Ви дали почитати»… — which way the book went, from the reader's side. */
  relation: string
  direction: 'in' | 'out'
  /** `tip` — what the status means, shown over the badge; the row's `hint` stays visible on its own. */
  badge: { label: string; tone: BadgeTone; tip: string }
  /** What the reader should know first: whose move it is, or the missed date. */
  hint: { text: string; isAlert: boolean } | null
  /** The dates the row shows, each already saying what it means. */
  dates: string[]
}

export type LoanListEmpty =
  /** Nothing at all in this list. */
  | 'none'
  /** Nothing on this side, while the other side has loans. */
  | 'side'
  /** Loans exist, the search or the status filter left none. An empty list is never this: no
      filter is why it is empty. */
  | 'results'

export type LoanListView = {
  rows: LoanRowView[]
  isFiltered: boolean
  /** «3 позики», or «Знайдено: 0 позик» under a search or a filter. */
  resultLabel: string
  empty: LoanListEmpty | null
  /** Why the filtered list is empty, for the «Нічого не знайдено» state. */
  noResultsText: string
}

/** A row and what it is filtered by. */
export type LoanRowCandidate = {
  row: LoanRowView
  status: ShownStatus
  /** The book's title and authors and the other side's name — never a guest's (there is none). */
  searchable: readonly string[]
}

export const GUEST_NAME = 'Гість, ім’я не показується'

const LOAN_NOUN = ['позика', 'позики', 'позик'] as const

/**
 * The search as a person means it: case, the edges and the kind of apostrophe do not matter
 * («Ковалів» finds «ковалів», «Мʼята» finds «М’ята» and «М'ята»).
 */
export function normalizeQuery(text: string): string {
  return text.toLocaleLowerCase('uk').replace(/[ʼ’`]/g, "'").replace(/\s+/g, ' ').trim()
}

export function toListView(
  candidates: readonly LoanRowCandidate[],
  filters: LoansFilters,
  /** The kind of emptiness when the list has nothing to filter. */
  whenEmpty: Exclude<LoanListEmpty, 'results'>,
  /** Where else to look when a status found nothing. */
  statusAdvice: string,
): LoanListView {
  const query = normalizeQuery(filters.query)
  const rows = candidates
    .filter(({ status }) => filters.status === null || status === filters.status)
    .filter(
      ({ searchable }) => query === '' || normalizeQuery(searchable.join(' ')).includes(query),
    )
    .map(({ row }) => row)
  const isFiltered = query !== '' || filters.status !== null
  const count = countNoun(rows.length, LOAN_NOUN)

  return {
    rows,
    isFiltered,
    resultLabel: isFiltered ? `Знайдено: ${count}` : count,
    empty: rows.length > 0 ? null : candidates.length > 0 ? 'results' : whenEmpty,
    noResultsText:
      query === ''
        ? `У цій вкладці немає позик із вибраним статусом. ${statusAdvice}`
        : `Немає позик за запитом «${filters.query.trim()}». Перевірте написання або шукайте за автором чи ім’ям друга.`,
  }
}

export function badgeOf(status: ShownStatus): LoanRowView['badge'] {
  return {
    label: shownStatusLabel(status),
    tone: badgeToneOf(status),
    tip: statusExplanationOf(status),
  }
}

export function authorsLine(authors: readonly WorkAuthor[]): string {
  return authors.map((author) => author.name).join(', ')
}

/** The canvas names the binding in full («Мʼяка обкладинка»); `EDITION_FORMAT_LABELS` are short. */
const EDITION_LINE_FORMATS: Readonly<Record<EditionFormat, string>> = {
  HARDCOVER: 'Тверда обкладинка',
  PAPERBACK: 'Мʼяка обкладинка',
  POCKET: 'Кишенькове видання',
}

/** The canvas's edition line: the format and the year, the rest is on the loan's own page. */
export function editionLine(edition: Pick<Edition, 'format' | 'year'>): string {
  return [
    edition.format === null ? null : EDITION_LINE_FORMATS[edition.format],
    edition.year === null ? null : String(edition.year),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

export const VIEW_LOAN = 'Переглянути позику'

/** The row's name: everything it says, in reading order, as the canvas spells it, then what pressing it does. */
export function rowAccessibleName(row: LoanRowView): string {
  const book = row.authors === '' ? row.title : `${row.title}, ${row.authors}`
  const person = `${row.person.name ?? GUEST_NAME}, ${row.relation.toLocaleLowerCase('uk')}`
  const parts = [book, person, `Статус: ${row.badge.label}`, row.hint?.text, ...row.dates]

  // A date already ends with «р.»: it closes its sentence itself, without a second full stop.
  return [...parts.filter((part): part is string => part !== undefined), row.action]
    .map((part, index, all) => (index === all.length - 1 || part.endsWith('.') ? part : `${part}.`))
    .join(' ')
}
