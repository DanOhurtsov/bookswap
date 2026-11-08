import type { Loan, LoanRole } from '@bookswap/shared'
import { formatDate } from '@/app/lib/labels'
import { badgeToneOf, shownStatusOf, type BadgeTone } from './loan-status'

/**
 * BS-153: the canvas's panel of the current state — where the loan stands and whose move it is —
 * above its actions. Its colour is the badge's (`badgeToneOf`): one status, one colour.
 *
 * Only what the product does: the borrower confirms a receipt, the owner marks a return, the term is
 * the date agreed on approval (`dueAt`, §8) and nothing counts from a handover. No reminder, extension
 * or notification is promised. Where `RecordedLoanActions` or `LostLoanRecovery` explain the state in
 * their own words, the panel has a title only, so nothing is said twice.
 */
export type LoanPanelView = {
  tone: BadgeTone
  title: string
  text: string | null
}

export function loanPanelOf(loan: Loan, role: LoanRole): LoanPanelView {
  const tone = badgeToneOf(shownStatusOf(loan))
  const { title, text } = role === 'owner' ? ownerPanel(loan) : borrowerPanel(loan)

  return { tone, title, text }
}

type PanelWords = { title: string; text: string | null }

function ownerPanel(loan: Loan): PanelWords {
  const due = loan.dueAt === null ? null : formatDate(loan.dueAt)

  if (loan.isOverdue) {
    return {
      title: 'Строк повернення минув',
      text: joined(
        due === null ? null : `Книжка мала повернутися до ${due}.`,
        'Коли вона повернеться, позначте це.',
      ),
    }
  }

  switch (loan.status) {
    case 'REQUESTED':
      return {
        title: `${loan.borrower.displayName} просить книжку`,
        text:
          due === null
            ? 'Погодьте запит або відмовте. Строк повернення вказуєте ви, погоджуючи запит.'
            : `Бажаний строк — до ${due}. Погодьте запит або відмовте; остаточний строк вказуєте ви.`,
      }
    case 'APPROVED':
      return {
        title: 'Домовтеся про передачу',
        text: joined('Отримання книжки підтверджує позичальник.', termLine(due)),
      }
    case 'HANDED_OVER':
      return {
        title: 'Книжка в позичальника',
        text: joined(
          termLine(due) ?? 'Строк повернення не вказано.',
          'Коли книжка повернеться, позначте це.',
        ),
      }
    case 'PENDING_CONFIRMATION':
      return { title: 'Чекаємо підтвердження запису', text: null }
    case 'DECLINED':
      return {
        title: 'Позичальник відхилив запис',
        text: 'Книжка знову вільна: можна записати заново.',
      }
    case 'REJECTED':
      return { title: 'Ви відмовили в запиті', text: dated('Відмовлено', loan.respondedAt) }
    case 'CANCELLED':
      return cancelledPanel(loan, 'owner')
    case 'RETURNED':
      return finishedPanel(loan)
    case 'LOST':
      return { title: 'Книжку позначено втраченою', text: null }
  }
}

function borrowerPanel(loan: Loan): PanelWords {
  const due = loan.dueAt === null ? null : formatDate(loan.dueAt)

  if (loan.isOverdue) {
    return {
      title: 'Час повернути книжку',
      text: joined(
        due === null ? null : `Строк повернення минув ${due}.`,
        'Повернення позначає власник, коли отримає книжку.',
      ),
    }
  }

  switch (loan.status) {
    case 'REQUESTED':
      return {
        title: 'Запит надіслано',
        text: joined('Власник ще не відповів.', due === null ? null : `Бажаний строк — до ${due}.`),
      }
    case 'APPROVED':
      return {
        title: 'Запит погоджено',
        text: joined(termLine(due), 'Коли отримаєте книжку, підтвердьте це.'),
      }
    case 'HANDED_OVER':
      return {
        title: 'Книжка у вас',
        text: joined(
          due === null ? 'Строк повернення не вказано.' : `Поверніть до ${due}.`,
          'Повернення позначає власник, коли отримає книжку.',
        ),
      }
    case 'PENDING_CONFIRMATION':
      return { title: 'Підтвердьте запис', text: null }
    case 'DECLINED':
      return { title: 'Ви відхилили запис', text: null }
    case 'REJECTED':
      return { title: 'Власник відмовив', text: dated('Відмовлено', loan.respondedAt) }
    case 'CANCELLED':
      return cancelledPanel(loan, 'borrower')
    case 'RETURNED':
      return finishedPanel(loan)
    case 'LOST':
      return {
        title: 'Власник позначив книжку втраченою',
        text: 'Якщо книжка знайдеться, скажіть про це власнику.',
      }
  }
}

/**
 * Who cancelled is told only where the data says it: a recorded loan is withdrawn by its owner, a
 * request without an answer (`respondedAt`) by its borrower. An agreement may be cancelled by either.
 */
function cancelledPanel(loan: Loan, role: LoanRole): PanelWords {
  if (loan.origin === 'RECORDED_EXISTING') {
    return {
      title: role === 'owner' ? 'Ви відкликали запис' : 'Власник відкликав запис',
      text: null,
    }
  }

  if (loan.respondedAt === null) {
    return {
      title: role === 'owner' ? 'Позичальник скасував запит' : 'Ви скасували запит',
      text: null,
    }
  }

  return { title: 'Домовленість скасовано', text: 'Скасовано до передачі книжки.' }
}

function finishedPanel(loan: Loan): PanelWords {
  return { title: 'Позику завершено', text: dated('Книжку повернено', loan.returnedAt) }
}

function termLine(due: string | null): string | null {
  return due === null ? null : `Строк повернення — до ${due}.`
}

function dated(fact: string, at: string | null): string | null {
  return at === null ? null : `${fact} ${formatDate(at)}.`
}

function joined(...sentences: (string | null)[]): string {
  return sentences.filter((sentence): sentence is string => sentence !== null).join(' ')
}
