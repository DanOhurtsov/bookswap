import { OPEN_LOAN_STATUS } from '@bookswap/shared'
import { PUBLIC_USER_FIELDS } from '../users/user.mapper'
import type { LoanStatus } from '../generated/prisma/enums'

/** Незавершені лоани — ті, що впливають на §6.5. Копія масиву: Prisma хоче змінюваний. */
const OPEN_LOAN_STATUSES: LoanStatus[] = [...OPEN_LOAN_STATUS]

/**
 * Каталожний контекст примірника — саме той набір полів, який читає
 * `library.mapper`. Один опис на всі запити: інакше «чому на одній сторінці є
 * автори, а на іншій немає» стало б регулярним питанням.
 */
export const WITH_CATALOG = {
  edition: {
    include: {
      translation: true,
      work: { include: { authors: { include: { author: true } } } },
    },
  },
  owner: { select: PUBLIC_USER_FIELDS },
  currentHolder: { select: PUBLIC_USER_FIELDS },
  /**
   * §6.5: стан кнопки «Попросити» не виводиться з `Copy.status` — за §5.1 запит
   * примірника не змінює, тож `AVAILABLE` не означає «ви ще не просили».
   *
   * Термінальні лоани не читаються: вони — історія, і для неї є `/copies/:id/history`.
   * Проєкція вужча за `WITH_CONTEXT` у `loans/`: тут потрібні лише id, статус і
   * позичальник, а самі мапери віддають із цього ще менше — і різне за роллю.
   */
  loans: {
    where: { status: { in: OPEN_LOAN_STATUSES } },
    select: {
      id: true,
      status: true,
      borrowerId: true,
      // §6.5: «орієнтовна дата повернення, якщо власник її вказав». Назовні з
      // цього рядка йде тільки вона — див. `expectedReturnOf`.
      dueAt: true,
      borrower: { select: PUBLIC_USER_FIELDS },
    },
  },
} as const
