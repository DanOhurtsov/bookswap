import type { Loan, LoanRole } from '@bookswap/shared'
import { CONDITION_LABELS, formatDate } from '@/app/lib/labels'
import { CURRENT_RELATIONS } from './current-loans-view'
import { HISTORY_RELATIONS } from './history-loans-view'
import { HISTORY_TAB, type LoansTab } from './loans-address'
import { authorsLine, badgeOf, editionLine, type LoanRowView } from './loan-row'
import { isOpenStatus, shownStatusOf } from './loan-status'

/**
 * BS-153: one loan's page as the canvas draws it — the book, the other side, the details and the
 * messages — already decided, so the components only draw it. The panel (`loanPanelOf`), the actions
 * (`actionPlanOf`) and the history (`loanTimelineOf`) are their own models.
 */
export type LoanPageView = {
  role: LoanRole
  book: {
    id: string
    title: string
    /** «Авторка, Автор»; empty when the work has none. */
    authors: string
    coverUrl: string | null
    href: string
  }
  badge: LoanRowView['badge']
  /** «Я позичаю», «Ви дали почитати»… — the same words as the loan's row in its list. */
  relation: string
  counterpart: {
    name: string
    avatarUrl: string | null
    href: string
    /** What the other side is to this loan: «Позичальник» or «Власник». */
    role: string
  }
  facts: { label: string; value: string }[]
  /** The borrower's words with the request, and the owner's with the answer — each as sent. */
  messages: { key: string; heading: string; text: string; byline: string }[]
  /** The list where this loan is, for a page opened by a direct link: open on its side, else history. */
  listTab: LoansTab
}

export function toLoanPageView(loan: Loan, userId: string): LoanPageView {
  const role: LoanRole = loan.owner.id === userId ? 'owner' : 'borrower'
  const counterpart = role === 'owner' ? loan.borrower : loan.owner
  const isOpen = isOpenStatus(loan.status)

  return {
    role,
    book: {
      id: loan.work.id,
      title: loan.work.title,
      authors: authorsLine(loan.authors),
      coverUrl: loan.edition.coverUrl,
      href: `/works/${encodeURIComponent(loan.work.id)}`,
    },
    badge: badgeOf(shownStatusOf(loan)),
    relation: isOpen
      ? CURRENT_RELATIONS[role]
      : HISTORY_RELATIONS[role === 'owner' ? 'lent' : 'borrowed'],
    counterpart: {
      name: counterpart.displayName,
      avatarUrl: counterpart.avatarUrl,
      href: `/u/${encodeURIComponent(counterpart.handle)}`,
      role: role === 'owner' ? 'Позичальник' : 'Власник',
    },
    facts: factsOf(loan),
    messages: messagesOf(loan, role),
    listTab: isOpen ? role : HISTORY_TAB,
  }
}

/**
 * Only what the loan carries. Before an answer `dueAt` is the borrower's wish, after it the agreed
 * term (§8) — never a return date. A recorded loan is dated by its record: it had no request.
 */
function factsOf(loan: Loan): LoanPageView['facts'] {
  const facts: LoanPageView['facts'] = [
    {
      label: loan.status === 'REQUESTED' ? 'Бажаний строк' : 'Строк повернення',
      value: loan.dueAt === null ? 'Не вказано' : formatDate(loan.dueAt),
    },
  ]
  const dated = (label: string, at: string | null) => {
    if (at !== null) facts.push({ label, value: formatDate(at) })
  }

  if (loan.origin === 'RECORDED_EXISTING') dated('Записано власником', loan.createdAt)
  else dated('Запит надіслано', loan.requestedAt)
  dated('Передано', loan.handedAt)
  dated('Повернено', loan.returnedAt)

  const edition = editionLine(loan.edition)

  if (edition !== '') facts.push({ label: 'Видання', value: edition })
  facts.push({ label: 'Стан примірника', value: CONDITION_LABELS[loan.copy.condition] })

  return facts
}

function messagesOf(loan: Loan, role: LoanRole): LoanPageView['messages'] {
  const messages: LoanPageView['messages'] = []
  const byline = (author: string, at: string | null) =>
    at === null ? author : `${author} · ${formatDate(at)}`

  if (loan.message !== null) {
    messages.push({
      key: 'message',
      heading: 'Повідомлення до запиту',
      text: loan.message,
      byline: byline(role === 'borrower' ? 'Ви' : loan.borrower.displayName, loan.requestedAt),
    })
  }

  if (loan.responseNote !== null) {
    messages.push({
      key: 'response',
      heading: 'Відповідь власника',
      text: loan.responseNote,
      byline: byline(role === 'owner' ? 'Ви' : loan.owner.displayName, loan.respondedAt),
    })
  }

  return messages
}
