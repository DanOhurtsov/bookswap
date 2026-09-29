import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type CreateGuestLoanConfirmationRequest,
  type GuestLoanConfirmationListResponse,
  type GuestLoanConfirmationResponse,
  type GuestConfirmationAction,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { recomputeRetainUntil } from '../external-borrowers/retention'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { resolveConfirmationTransition } from './guest-loan-confirmation.transitions'
import {
  asGuestConfirmation,
  GUEST_CONFIRMATION_LOAN_STATUSES,
  toGuestConfirmation,
  type GuestConfirmationRow,
  type UnvalidatedGuestConfirmationRow,
} from './guest-loan-confirmation.mapper'
import {
  assertGuestLoanDates,
  assertSingleRow,
  copyUnavailable,
  GuestLoanService,
  notFoundContact,
  notFoundCopy,
  notFoundLoan,
  toHandedDate,
} from './guest-loan.service'
import { LoanEventService } from './loan-event.service'
import { toDueDate } from './loan.mapper'
import type { LoanWhereInput } from '../generated/prisma/models'

/**
 * Каталожний і контактний контекст запиту — рівно те, що читає `guest-loan-confirmation.mapper`.
 * Нікнейм/email гостя читаються лише тут (owner-only ресурс) і лише для власника контакту.
 */
const WITH_CONFIRMATION_CONTEXT = {
  externalBorrower: {
    select: {
      id: true,
      alias: true,
      guestNickname: true,
      guestEmail: true,
      guestEmailVerifiedAt: true,
    },
  },
  loan: {
    include: {
      copy: {
        include: {
          edition: {
            include: {
              translation: true,
              work: { include: { authors: { include: { author: true } } } },
            },
          },
        },
      },
    },
  },
}

/**
 * Межа валідних гостьових рядків (той самий принцип, що `GUEST_LOAN_ROW`): CHECK статус `Loan` не
 * обмежує, тож фільтр — частина авторизаційного запиту, а не постобробка. Чужі й синтетичні рядки
 * не читаються взагалі.
 */
const guestConfirmationLoanFilter = (ownerId: string): LoanWhereInput => ({
  ownerId,
  origin: 'RECORDED_GUEST',
  borrowerKind: 'GUEST',
  status: { in: [...GUEST_CONFIRMATION_LOAN_STATUSES] },
  handedAt: { not: null },
})

interface ConfirmationLookupRow {
  loanId: string
  copyId: string
  externalBorrowerId: string | null
}

/**
 * Stage 10 (10i.1, §0.13). Owner-only запит гостьового підтвердження: створення після фізичної
 * передачі, перегляд, скасування помилкової передачі, запис лише зі слів власника. Публічної
 * відповіді гостя, посилань, токенів, email-коду й сповіщень тут НЕМАЄ (10i.2/10i.3).
 *
 * Порядок локів (§6.11.2): `ExternalBorrower → Copy → Loan → GuestLoanConfirmation` — той самий, що в
 * `GuestLoanService`/ручному `DELETE`/CLI-чистці. Авторизація (ownerId) вбудована в локувальні запити.
 * Фонових сервісів немає.
 */
@Injectable()
export class GuestLoanConfirmationService {
  private readonly logger = new Logger(GuestLoanConfirmationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly loanEvents: LoanEventService,
    private readonly guestLoans: GuestLoanService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Owner-only: `GET /guest-loan-confirmations`. */
  async list(ownerId: string): Promise<GuestLoanConfirmationListResponse> {
    const rows = await this.prisma.guestLoanConfirmation.findMany({
      where: { loan: guestConfirmationLoanFilter(ownerId) },
      include: WITH_CONFIRMATION_CONTEXT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const now = new Date()

    return { confirmations: rows.map((row) => toGuestConfirmation(requireRow(row), now)) }
  }

  /** Owner-only: `GET /guest-loan-confirmations/:id`. Чужий, неіснуючий і синтетичний — однаково 404. */
  async get(ownerId: string, id: string): Promise<GuestLoanConfirmationResponse> {
    const row = await this.prisma.guestLoanConfirmation.findFirst({
      where: { id, loan: guestConfirmationLoanFilter(ownerId) },
      include: WITH_CONFIRMATION_CONTEXT,
    })

    if (row === null) throw notFoundConfirmation()

    return { confirmation: toGuestConfirmation(requireRow(row)) }
  }

  /** `POST /guest-loan-confirmations`. */
  async create(
    ownerId: string,
    request: CreateGuestLoanConfirmationRequest,
  ): Promise<GuestLoanConfirmationResponse> {
    const row = await this.prisma.$transaction((tx) => this.createRequest(tx, ownerId, request))

    this.logger.log(`Запит гостьового підтвердження ${row.id}: створено, власник ${ownerId}`)

    return { confirmation: toGuestConfirmation(row) }
  }

  private async createRequest(
    tx: TransactionClient,
    ownerId: string,
    request: CreateGuestLoanConfirmationRequest,
  ): Promise<GuestConfirmationRow> {
    // 1. ExternalBorrower — перший ресурс порядку. Чужий/відсутній контакт не дає рядків.
    const [lockedContact] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${request.externalBorrowerId} AND "ownerId" = ${ownerId} FOR UPDATE
    `

    if (lockedContact === undefined) throw notFoundContact()

    // 2. Copy — другий ресурс.
    const [lockedCopy] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Copy" WHERE "id" = ${request.copyId} AND "ownerId" = ${ownerId} FOR UPDATE
    `

    if (lockedCopy === undefined) throw notFoundCopy()

    const copy = await tx.copy.findUnique({
      where: { id: request.copyId },
      select: {
        id: true,
        ownerId: true,
        status: true,
        currentHolderId: true,
        heldByContactId: true,
        archivedAt: true,
      },
    })

    if (copy === null || copy.ownerId !== ownerId) throw notFoundCopy()

    if (copy.archivedAt !== null) {
      throw new ApiException(
        API_ERROR_CODES.COPY_ARCHIVED,
        'Примірник в архіві: спершу відновіть його з архіву',
        HttpStatus.CONFLICT,
      )
    }

    if (
      copy.status !== 'AVAILABLE' ||
      copy.currentHolderId !== copy.ownerId ||
      copy.heldByContactId !== null
    ) {
      throw copyUnavailable()
    }

    assertGuestLoanDates(request.handedAt, request.dueAt ?? null, new Date())

    // 3. Loan — третій ресурс (новий рядок; конкурентів у нього ще немає). Тримач-контакт відображає
    //    фізичну передачу, але `PENDING_CONFIRMATION` не є підтвердженням отримання.
    const loan = await tx.loan.create({
      data: {
        copyId: copy.id,
        ownerId: copy.ownerId,
        borrowerId: null,
        borrowerKind: 'GUEST',
        origin: 'RECORDED_GUEST',
        borrowerContactId: request.externalBorrowerId,
        status: 'PENDING_CONFIRMATION',
        requestedAt: null,
        handedAt: toHandedDate(request.handedAt),
        dueAt: toDueDate(request.dueAt ?? null),
      },
    })

    const changed = await tx.copy.updateMany({
      where: {
        id: copy.id,
        status: 'AVAILABLE',
        currentHolderId: copy.ownerId,
        heldByContactId: null,
      },
      data: {
        status: 'RESERVED',
        currentHolderId: null,
        heldByContactId: request.externalBorrowerId,
      },
    })

    assertSingleRow(changed.count)

    // 4. GuestLoanConfirmation — четвертий ресурс. Чужі `REQUESTED` НЕ чіпаємо (§0.13 п. 3): їх
    //    відхиляють лише при підтвердженому отриманні (10i.2) або записі зі слів власника.
    const confirmation = await tx.guestLoanConfirmation.create({
      data: { loanId: loan.id, externalBorrowerId: request.externalBorrowerId, status: 'OPEN' },
    })

    await this.loanEvents.record(tx, {
      loanId: loan.id,
      type: 'GUEST_CONFIRMATION_REQUESTED',
      actorId: ownerId,
    })

    // Позика активна (`PENDING_CONFIRMATION` ∈ EXCLUSIVE_LOAN_STATUS) → `retainUntil = NULL`.
    await recomputeRetainUntil(tx, request.externalBorrowerId)

    return this.readRow(tx, confirmation.id)
  }

  /**
   * `PATCH /guest-loan-confirmations/:id`: `cancel_handover` (помилкову передачу скасовано — книжка
   * фізично у власника) або `record_owner_statement` (позика лишається активною як запис лише зі слів
   * власника). Обидві — лише з `OPEN`/`DENIED`.
   */
  async apply(
    ownerId: string,
    id: string,
    request: { action: GuestConfirmationAction },
  ): Promise<GuestLoanConfirmationResponse> {
    const row = await this.prisma.$transaction((tx) => this.applyAction(tx, ownerId, id, request))

    this.logger.log(
      `Запит гостьового підтвердження ${id}: дія ${request.action}, власник ${ownerId}`,
    )
    this.notifications.dispatchSoon()

    return { confirmation: toGuestConfirmation(row) }
  }

  private async applyAction(
    tx: TransactionClient,
    ownerId: string,
    id: string,
    request: { action: GuestConfirmationAction },
  ): Promise<GuestConfirmationRow> {
    // 0. Нелокований пошук лише вирішує, ЯКІ ресурси locати першими; він нічого не авторизує сам, але
    //    авторизація (ownerId) у ньому вже є: чужий/синтетичний рядок не дає нічого й лок не береться.
    const [lookup] = await tx.$queryRaw<ConfirmationLookupRow[]>`
      SELECT gc."loanId", l."copyId", gc."externalBorrowerId"
      FROM "GuestLoanConfirmation" gc
      JOIN "Loan" l ON l."id" = gc."loanId"
      WHERE gc."id" = ${id} AND l."ownerId" = ${ownerId}
        AND l."origin" = 'RECORDED_GUEST' AND l."borrowerKind" = 'GUEST'
    `

    if (lookup === undefined) throw notFoundConfirmation()

    // 1. ExternalBorrower. Контакт, щойно стертий конкурентом, — не помилка тут: нижче лок
    //    підтвердження покаже свіжий стан, і термінальний рядок дасть 409.
    if (lookup.externalBorrowerId !== null) {
      await tx.$queryRaw`
        SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${lookup.externalBorrowerId} AND "ownerId" = ${ownerId} FOR UPDATE
      `
    }

    // 2. Copy. 3. Loan. 4. GuestLoanConfirmation — і статус перечитується САМЕ з локованого рядка.
    await tx.$queryRaw`
      SELECT "id" FROM "Copy" WHERE "id" = ${lookup.copyId} AND "ownerId" = ${ownerId} FOR UPDATE
    `
    await tx.$queryRaw`
      SELECT "id" FROM "Loan" WHERE "id" = ${lookup.loanId} AND "ownerId" = ${ownerId} FOR UPDATE
    `

    const [lockedConfirmation] = await tx.$queryRaw<
      { status: GuestConfirmationRow['status']; externalBorrowerId: string | null }[]
    >`
      SELECT "status", "externalBorrowerId" FROM "GuestLoanConfirmation" WHERE "id" = ${id} FOR UPDATE
    `

    if (lockedConfirmation === undefined) throw notFoundConfirmation()

    const transition = resolveConfirmationTransition(lockedConfirmation.status, request.action)

    if (transition === null) {
      throw new ApiException(
        API_ERROR_CODES.LOAN_INVALID_TRANSITION,
        'Дія неможлива в поточному стані запиту підтвердження',
        HttpStatus.CONFLICT,
      )
    }

    // 5. Перечитування ПІСЛЯ локів: рішення на свіжому стані, а не на знімку до очікування.
    const loan = await tx.loan.findUnique({ where: { id: lookup.loanId } })
    const copy = await tx.copy.findUnique({ where: { id: lookup.copyId } })
    const contactId = lockedConfirmation.externalBorrowerId

    if (loan === null || copy === null) throw notFoundLoan()

    // Структурна передумова: відкритий запит завжди має `PENDING_CONFIRMATION`/`RESERVED` у контакта.
    // Розбіжність — зміна в обхід сервісу; жодної мутації, лише 409.
    if (
      loan.status !== 'PENDING_CONFIRMATION' ||
      contactId === null ||
      loan.borrowerContactId !== contactId ||
      copy.status !== 'RESERVED' ||
      copy.currentHolderId !== null ||
      copy.heldByContactId !== contactId
    ) {
      throw new ApiException(
        API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
        'Стан примірника змінився — оновіть сторінку',
        HttpStatus.CONFLICT,
      )
    }

    const now = new Date()
    const loanUpdated = await tx.loan.updateMany({
      where: { id: loan.id, status: 'PENDING_CONFIRMATION' },
      data: { status: transition.loanTo },
    })

    assertSingleRow(loanUpdated.count)

    const copyUpdated = await tx.copy.updateMany({
      where: { id: copy.id, status: 'RESERVED', heldByContactId: contactId },
      data:
        transition.copyTo === 'AVAILABLE'
          ? { status: 'AVAILABLE', currentHolderId: ownerId, heldByContactId: null }
          : { status: 'LENT_OUT' },
    })

    assertSingleRow(copyUpdated.count)

    if (transition.rejectsRequestedRivals) {
      await this.guestLoans.rejectRequestedRivals(tx, copy.id, ownerId, now)
    }

    const confirmationUpdated = await tx.guestLoanConfirmation.updateMany({
      where: { id, status: lockedConfirmation.status },
      data: { status: transition.confirmationTo, resolvedAt: now },
    })

    assertSingleRow(confirmationUpdated.count)

    await this.loanEvents.record(tx, {
      loanId: loan.id,
      type: transition.event,
      actorId: ownerId,
    })

    // Перерахунок у ТІЙ САМІЙ транзакції: скасування дає `cancelledAt + 90д`, запис — активна → NULL.
    await recomputeRetainUntil(tx, contactId)

    return this.readRow(tx, id)
  }

  private async readRow(tx: TransactionClient, id: string): Promise<GuestConfirmationRow> {
    return requireRow(
      await tx.guestLoanConfirmation.findUniqueOrThrow({
        where: { id },
        include: WITH_CONFIRMATION_CONTEXT,
      }),
    )
  }
}

/** Той самий звужений перелік, що в `GuestLoanService`, плюс `guestLoanConfirmation`. */
type TransactionClient = Pick<
  PrismaService,
  | 'loan'
  | 'loanEvent'
  | 'copy'
  | 'externalBorrower'
  | 'guestLoanConfirmation'
  | 'notification'
  | 'notificationDelivery'
  | 'notificationPreference'
  | 'user'
  | '$queryRaw'
>

/** Друга лінія захисту: якщо фільтр читача колись розійдеться з мапером — падаємо гучно. */
function requireRow(row: UnvalidatedGuestConfirmationRow): GuestConfirmationRow {
  const confirmation = asGuestConfirmation(row)

  if (confirmation === null) {
    throw new Error(
      'Очікувався запит гостьового підтвердження з допустимим статусом позики і handedAt — ' +
        'фільтр читача мав це виключити',
    )
  }

  return confirmation
}

function notFoundConfirmation(): ApiException {
  return new ApiException(
    API_ERROR_CODES.NOT_FOUND,
    'Запит підтвердження не знайдено',
    HttpStatus.NOT_FOUND,
  )
}
