import type { Loan } from '@bookswap/shared'
import { formatDate } from '@/app/lib/labels'

/**
 * BS-153: «Історія позики» — only facts `GET /loans/:id` carries, in the order they happened.
 *
 * - `origin` decides the start: a request (`requestedAt`, `respondedAt`) or an owner's record of a
 *   book already given (`handedAt` as the owner stated it, `createdAt`) — a record had no request.
 * - `respondedAt` is the owner's answer: an approval, or the refusal of a `REJECTED` loan.
 * - The API keeps no date for a cancellation, a loss, a declined or confirmed record: those steps
 *   are told without one rather than given a guessed date.
 * - `dueAt` is the agreed term, never a return; the next step is only expected (`next`), undated.
 */
export type TimelineTone = 'done' | 'muted' | 'alert' | 'next'

export type TimelineStep = {
  key: string
  title: string
  /** Already formatted; `null` — the API keeps no date for this step. */
  date: string | null
  /** The ISO value of `date`, for `<time dateTime>`. */
  dateTime: string | null
  note: string | null
  tone: TimelineTone
}

export function loanTimelineOf(loan: Loan): TimelineStep[] {
  return [
    ...(loan.origin === 'RECORDED_EXISTING' ? recordSteps(loan) : requestSteps(loan)),
    ...handedSteps(loan),
  ]
}

function requestSteps(loan: Loan): TimelineStep[] {
  const steps: TimelineStep[] = []

  if (loan.requestedAt !== null) steps.push(step('requested', 'Запит надіслано', loan.requestedAt))

  if (loan.respondedAt !== null) {
    steps.push(
      loan.status === 'REJECTED'
        ? step('rejected', 'Власник відмовив', loan.respondedAt, 'muted')
        : step('approved', 'Запит погоджено', loan.respondedAt),
    )
  }

  switch (loan.status) {
    case 'REQUESTED':
      steps.push(next('answer', 'Відповідь власника'))
      break
    case 'APPROVED':
      steps.push(next('receive', 'Отримання книжки', 'Підтверджує позичальник'))
      break
    case 'CANCELLED':
      steps.push(
        step(
          'cancelled',
          loan.respondedAt === null ? 'Запит скасовано' : 'Домовленість скасовано',
          null,
          'muted',
        ),
      )
      break
    default:
      break
  }

  if (loan.handedAt !== null) steps.push(step('handed', 'Книжку отримано', loan.handedAt))

  return steps
}

function recordSteps(loan: Loan): TimelineStep[] {
  const steps: TimelineStep[] = []

  if (loan.handedAt !== null) {
    steps.push({ ...step('handed', 'Книжку передано', loan.handedAt), note: 'Дату вказав власник' })
  }

  steps.push(step('recorded', 'Власник записав позику', loan.createdAt))

  switch (loan.status) {
    case 'PENDING_CONFIRMATION':
      steps.push(next('confirm', 'Підтвердження позичальника'))
      break
    case 'DECLINED':
      steps.push(step('declined', 'Позичальник відхилив запис', null, 'muted'))
      break
    case 'CANCELLED':
      steps.push(step('withdrawn', 'Власник відкликав запис', null, 'muted'))
      break
    case 'HANDED_OVER':
    case 'RETURNED':
    case 'LOST':
      steps.push(step('confirmed', 'Позичальник підтвердив запис', null))
      break
    default:
      break
  }

  return steps
}

/** What follows the book reaching the borrower, whichever way it began. */
function handedSteps(loan: Loan): TimelineStep[] {
  const steps: TimelineStep[] = []
  const term = loan.dueAt === null ? null : `Строк — до ${formatDate(loan.dueAt)}`

  if (loan.isOverdue) {
    steps.push({ ...step('overdue', 'Строк повернення минув', null, 'alert'), note: term })
  }

  if (loan.status === 'HANDED_OVER') steps.push(next('return', 'Повернення', term))
  if (loan.returnedAt !== null) steps.push(step('returned', 'Книжку повернено', loan.returnedAt))
  if (loan.status === 'LOST') steps.push(step('lost', 'Позначено втраченою', null, 'alert'))

  if (loan.recovery !== null) {
    steps.push(step('recovered', 'Книжка знайшлася', loan.recovery.effectiveAt))
  }

  return steps
}

function step(
  key: string,
  title: string,
  at: string | null,
  tone: TimelineTone = 'done',
): TimelineStep {
  return {
    key,
    title,
    date: at === null ? null : formatDate(at),
    dateTime: at,
    note: null,
    tone,
  }
}

function next(key: string, title: string, note: string | null = null): TimelineStep {
  return { key, title, date: null, dateTime: null, note, tone: 'next' }
}
