import { EXCLUSIVE_LOAN_STATUS } from '@bookswap/shared'
import type { PrismaService } from '../prisma/prisma.service'

const DAY_MS = 24 * 60 * 60 * 1000

/** Q2 (docs/plan/stage-10-real-world-history.md §0.9): контакт без жодної позики — 90 днів від `createdAt`. */
export const RETENTION_NO_LOAN_WINDOW_MS = 90 * DAY_MS

/**
 * Q3/Q3b (§0.7/§0.7.1): 90 днів від серверного моменту закриття — `Loan.returnedAt` для
 * `RETURNED`, перша за часом подія `RECOVERED`/`LOSS_CLOSED` для позики, закритої через `LOST`.
 */
export const RETENTION_CLOSED_WINDOW_MS = 90 * DAY_MS

/**
 * Q3a (§0.9): 365 днів від власного `LoanEvent LOAN_LOST.occurredAt` кожної ще НЕ закритої
 * `LOST`-позики контакту. `LOST` сама по собі 90-денний строк D3 не запускає (Q3, §0.7).
 */
export const RETENTION_UNRESOLVED_LOSS_WINDOW_MS = 365 * DAY_MS

const EXCLUSIVE_STATUSES: readonly string[] = EXCLUSIVE_LOAN_STATUS
const CLOSURE_EVENT_TYPES = new Set(['RECOVERED', 'LOSS_CLOSED'])

/**
 * Мінімальний зріз `PrismaService`/клієнта транзакції, потрібний для перерахунку.
 *
 * ВАЖЛИВО (§6.11.2 execution plan, розширено для 10h): викликач мусить УЖЕ тримати `FOR UPDATE`
 * лок на рядку `ExternalBorrower` до виклику — ця функція сама лока не бере. Причина — глобальний
 * порядок локів `ExternalBorrower → Copy → Loan`: якщо перехід (`return`/`mark_lost`/`recover`/
 * `close_loss`) бере лок на `ExternalBorrower` лише ТУТ, після того, як уже тримає `Copy`/`Loan`,
 * порядок для цієї транзакції стає `Copy → Loan → ExternalBorrower` — зворотним до порядку, яким
 * іде `DELETE` (`ExternalBorrower → Copy → Loan`), а це і є класичний цикл очікування
 * (`DELETE` тримає `ExternalBorrower`, чекає на `Copy`, який тримає перехід; перехід тримає
 * `Copy`/`Loan`, чекає на `ExternalBorrower`, який тримає `DELETE`). Тому лок на
 * `ExternalBorrower` для 10h узятий викликачами (`GuestLoanService`) ПЕРШИМ кроком їхньої
 * транзакції — до будь-якого локу `Copy`/`Loan` — так само, як уже роблять `create`/`DELETE`.
 */
export type RetentionTxClient = Pick<PrismaService, 'externalBorrower' | 'loan' | 'loanEvent'>

interface LoanFacts {
  id: string
  status: string
  returnedAt: Date | null
}

interface EventFacts {
  loanId: string
  type: string
  occurredAt: Date
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms)
}

function candidateFor(loan: LoanFacts, events: readonly EventFacts[]): Date {
  if (loan.status === 'RETURNED') {
    if (loan.returnedAt === null) {
      throw new Error(`Позика ${loan.id}: RETURNED без returnedAt — цілісність даних порушена`)
    }

    return addMs(loan.returnedAt, RETENTION_CLOSED_WINDOW_MS)
  }

  if (loan.status === 'LOST') {
    const closures = events.filter(
      (event) => event.loanId === loan.id && CLOSURE_EVENT_TYPES.has(event.type),
    )

    if (closures.length > 0) {
      // Q3c (§0.7.1): `closedAt` — ПЕРША за часом подія закриття; пізніша друга подія
      // (напр. `recover` після вже записаної `LOSS_CLOSED`) цей момент не пересуває.
      const closedAt = closures.reduce(
        (earliest, event) => (event.occurredAt < earliest ? event.occurredAt : earliest),
        closures[0]!.occurredAt,
      )

      return addMs(closedAt, RETENTION_CLOSED_WINDOW_MS)
    }

    const lost = events.find((event) => event.loanId === loan.id && event.type === 'LOAN_LOST')

    if (lost === undefined) {
      throw new Error(`Позика ${loan.id}: LOST без LoanEvent LOAN_LOST — цілісність даних порушена`)
    }

    return addMs(lost.occurredAt, RETENTION_UNRESOLVED_LOSS_WINDOW_MS)
  }

  throw new Error(
    `Позика ${loan.id}: неочікуваний статус ${loan.status} для перерахунку retainUntil`,
  )
}

/**
 * Q1/Q2/Q3/Q3a/Q3b/Q3c (docs/plan/stage-10-real-world-history.md §0.7/§0.7.1/§0.9/§6.11).
 *
 * Обчислює й записує `ExternalBorrower.retainUntil` для контакту `contactId` — виключно за
 * фактами `Loan`/`LoanEvent`, уже видимими `tx` (жодної вигаданої дати: лише читання того, що
 * реально записано). Той самий принцип, що й решта переходів: рішення на перечитаному, не
 * закешованому стані.
 *
 * Формула:
 *   - контакту взагалі немає жодної позики → `createdAt + 90д`;
 *   - є хоча б одна активна позика (`EXCLUSIVE_LOAN_STATUS`) → `NULL`;
 *   - інакше — `max()` по всіх позиках контакту: `RETURNED` дає `returnedAt + 90д`; закрита
 *     (`RECOVERED`/`LOSS_CLOSED`) `LOST` дає `closedAt + 90д`; ще НЕ закрита `LOST` дає
 *     `LOAN_LOST.occurredAt + 365д` — кожна незакрита `LOST` окремо, без взаємного витіснення.
 *
 * Якщо контакт конкурентно видалено між тим, як викликач дізнався його id, і цим викликом
 * (можливо лише якщо викликач порушив контракт локу вище), функція мовчки нічого не робить.
 */
export async function recomputeRetainUntil(
  tx: RetentionTxClient,
  contactId: string,
): Promise<void> {
  const contact = await tx.externalBorrower.findUnique({
    where: { id: contactId },
    select: { createdAt: true },
  })

  if (contact === null) return

  const loans = await tx.loan.findMany({
    where: { borrowerContactId: contactId },
    select: { id: true, status: true, returnedAt: true },
  })

  let retainUntil: Date | null

  if (loans.length === 0) {
    retainUntil = addMs(contact.createdAt, RETENTION_NO_LOAN_WINDOW_MS)
  } else if (loans.some((loan) => EXCLUSIVE_STATUSES.includes(loan.status))) {
    retainUntil = null
  } else {
    const events = await tx.loanEvent.findMany({
      where: {
        loanId: { in: loans.map((loan) => loan.id) },
        type: { in: ['LOAN_LOST', 'RECOVERED', 'LOSS_CLOSED'] },
      },
      select: { loanId: true, type: true, occurredAt: true },
    })

    const candidates = loans.map((loan) => candidateFor(loan, events))

    retainUntil = candidates.reduce((max, candidate) => (candidate > max ? candidate : max))
  }

  await tx.externalBorrower.update({ where: { id: contactId }, data: { retainUntil } })
}
