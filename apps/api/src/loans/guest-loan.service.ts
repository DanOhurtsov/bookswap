import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  EXCLUSIVE_LOAN_STATUS,
  type CreateGuestLoanRequest,
  type GuestLoanListResponse,
  type GuestLoanResponse,
  type LoanEventType,
  type UpdateGuestLoanRequest,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { isUniqueViolationOn } from '../common/prisma-errors'
import { recomputeRetainUntil } from '../external-borrowers/retention'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  asGuestLoan,
  GUEST_LOAN_STATUSES,
  toGuestLoan,
  type GuestLoanRow,
  type UnvalidatedGuestLoanRow,
} from './guest-loan.mapper'
import { LoanEventService } from './loan-event.service'
import { toDueDate } from './loan.mapper'
import { resolveLoanTransition } from './loan.transitions'
import type { LoanWhereInput } from '../generated/prisma/models'

/**
 * Stage 10 (10f.3, M8b): частковий унікальний індекс `LoanEvent (loanId) WHERE type = 'LOSS_CLOSED'`
 * — не більше однієї події закриття втрати на позику. Друга лінія оборони за локом (§6.11.2 плану).
 */
export const ONE_LOSS_CLOSURE_PER_LOAN = 'one_loss_closure_per_loan'

/** Лише факти закриття — решта audit trail сюди не входить (той самий принцип, що в `WITH_CONTEXT`). */
const CLOSURE_EVENT_TYPES: LoanEventType[] = ['RECOVERED', 'LOSS_CLOSED']

/**
 * Каталожний контекст гостьової позики — рівно те, що читає `guest-loan.mapper`.
 *
 * Без `as const` навмисно (на відміну від `WITH_CONTEXT` у `LoanService`): `events.where.type.in`
 * — масив, а не одне значення, і Prisma очікує саме мутабельний `LoanEventType[]`, тож `as const`
 * тут дав би тип, вужчий за те, що приймає клієнт.
 */
const WITH_GUEST_CONTEXT = {
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
  borrowerContact: { select: { id: true, alias: true } },
  guestConfirmation: { select: { status: true } },
  events: {
    where: { type: { in: CLOSURE_EVENT_TYPES } },
    select: { type: true, occurredAt: true, effectiveAt: true },
  },
}

/**
 * Межа валідних гостьових рядків для `list`/`get`/`apply` (§6.2.3 review: CHECK
 * `loan_borrower_kind_valid` обмежує лише `borrowerId`/`borrowerContactId` відносно
 * `borrowerKind` — він НЕ обмежує `status`. Синтетичний чи зіпсований рядок
 * (`borrowerKind='GUEST'`, `status='REQUESTED'` тощо) не проходить цей фільтр: `list` його не
 * покаже, `get`/`apply` дадуть 404 без жодної мутації. Фільтр застосовується як частина
 * авторизаційного/локувального запиту, а не після нього.
 */
const GUEST_LOAN_ROW = {
  origin: 'RECORDED_GUEST',
  borrowerKind: 'GUEST',
  status: { in: [...GUEST_LOAN_STATUSES] },
  handedAt: { not: null },
} as const satisfies LoanWhereInput

/** Рядок, який повертає локувальний запит на `Copy`. */
interface CopyLockRow {
  copyId: string
}

/**
 * Stage 10 (10f.3). Гостьова позика — власна, вужча стейт-машина (`resolveGuestTransition`,
 * `loan.transitions.ts`), але рішення «яку таблицю переходів запитати» проходить крізь спільний
 * диспетчер `resolveLoanTransition` (той самий, що й `LoanService.runTransition`) — не окрему,
 * паралельну точку входу. `LoanService.runTransition` цю позику все одно НЕ обслуговує (лок-запит
 * там явно виключає `origin = RECORDED_GUEST`, `loan.service.ts:600-608`) — гість не має акаунта,
 * тож немає ні протилежної сторони, ні запиту, ні підтвердження; транзакційна обв'язка (лок, запис,
 * сповіщення) тут своя, а не спільна з `LoanService` — об'єднувати два різні по формі рядка `Loan`
 * заради спільного сервісу означало б узагальнювати без потреби.
 *
 * §6.11.2 execution plan: глобальний порядок локів `ExternalBorrower → Copy → Loan`, авторизація —
 * у самому локувальному запиті, перечитування після кожного очікування.
 */
@Injectable()
export class GuestLoanService {
  private readonly logger = new Logger(GuestLoanService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly loanEvents: LoanEventService,
  ) {}

  /** Owner-only: `GET /loans/guest`. `GUEST_LOAN_ROW` виключає синтетичні/зіпсовані рядки. */
  async list(ownerId: string): Promise<GuestLoanListResponse> {
    const rows = await this.prisma.loan.findMany({
      where: { ownerId, ...GUEST_LOAN_ROW },
      include: WITH_GUEST_CONTEXT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const now = new Date()

    return { loans: rows.map((row) => toGuestLoan(requireGuestRow(row), now)) }
  }

  /** Owner-only: `GET /loans/guest/:id`. Чужа, неіснуюча й синтетична позика — однаково 404. */
  async get(ownerId: string, id: string): Promise<GuestLoanResponse> {
    const row = await this.prisma.loan.findFirst({
      where: { id, ownerId, ...GUEST_LOAN_ROW },
      include: WITH_GUEST_CONTEXT,
    })

    if (row === null) throw notFoundLoan()

    return { loan: toGuestLoan(requireGuestRow(row)) }
  }

  /**
   * `POST /loans/guest`. §6.11.2: `ExternalBorrower` локається першим, `Copy` — другим (глобальний
   * порядок `ExternalBorrower → Copy → Loan`); авторизація вбудована в обидва локувальні запити.
   */
  async create(ownerId: string, request: CreateGuestLoanRequest): Promise<GuestLoanResponse> {
    const loan = await this.prisma.$transaction((tx) => this.createGuestLoan(tx, ownerId, request))

    this.logger.log(`Гостьова позика ${loan.id}: — → HANDED_OVER, власник ${ownerId}`)
    this.notifications.dispatchSoon()

    return { loan: toGuestLoan(loan) }
  }

  private async createGuestLoan(
    tx: TransactionClient,
    ownerId: string,
    request: CreateGuestLoanRequest,
  ): Promise<GuestLoanRow> {
    // 1. ExternalBorrower — перший ресурс глобального порядку (§6.11.2 плану). Авторизація в самому
    //    запиті: чужий чи відсутній контакт не дає рядків, лок не береться — і жоден наступний крок
    //    не сканує `Copy` за неперевіреним `id`.
    const [lockedContact] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${request.externalBorrowerId} AND "ownerId" = ${ownerId} FOR UPDATE
    `

    if (lockedContact === undefined) throw notFoundContact()

    // 2. Copy — другий ресурс. Той самий принцип авторизації.
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

    // Власність уже перевірено під локом; `null`/розбіжність тут означає лише зіпсовані дані.
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

    const now = new Date()

    assertGuestLoanDates(request.handedAt, request.dueAt ?? null, now)

    const created = await tx.loan.create({
      data: {
        copyId: copy.id,
        ownerId: copy.ownerId,
        borrowerId: null,
        borrowerKind: 'GUEST',
        origin: 'RECORDED_GUEST',
        borrowerContactId: request.externalBorrowerId,
        status: 'HANDED_OVER',
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
        status: 'LENT_OUT',
        currentHolderId: null,
        heldByContactId: request.externalBorrowerId,
      },
    })

    assertSingleRow(changed.count)

    // НОВЕ рішення PO (цей крок 10f.3): наявні звичайні REQUESTED на той самий Copy атомарно
    // відхиляються зі звичайним LOAN_REJECTED — окреме рішення для guest creation, Q22 не закриває.
    await this.rejectRequestedRivals(tx, copy.id, ownerId, now)

    await this.loanEvents.record(tx, {
      loanId: created.id,
      type: 'GUEST_LOAN_RECORDED',
      actorId: ownerId,
    })

    // Stage 10 (10h, §0.9 execution plan): нова активна позика скидає retainUntil контакту в
    // NULL — той самий перерахунок, що й на return/mark_lost/recover/close_loss. ExternalBorrower
    // уже locований кроком 1 вище (§6.11.2) — тут повторного локу не потрібно.
    await recomputeRetainUntil(tx, request.externalBorrowerId)

    return requireGuestRow(
      await tx.loan.findUniqueOrThrow({ where: { id: created.id }, include: WITH_GUEST_CONTEXT }),
    )
  }

  /**
   * §6.2 execution plan: наявні `REQUESTED` (`origin = REQUESTED`, `borrowerKind = REGISTERED`) на
   * цей `Copy` відхиляються атомарно в момент створення гостьової позики — той самий механізм, що
   * `rejectRivals` у `LoanService` (§5.1), але для guest-create, не для `approve`/`confirm_record`.
   *
   * Публічний (10i.1): той самий механізм використовує перехід «запис лише зі слів власника» в
   * `GuestLoanConfirmationService`. Викликач мусить тримати локи `ExternalBorrower → Copy`.
   */
  async rejectRequestedRivals(
    tx: TransactionClient,
    copyId: string,
    actorId: string,
    now: Date,
  ): Promise<void> {
    const rivals = await tx.loan.findMany({
      where: { copyId, status: 'REQUESTED', origin: 'REQUESTED', borrowerKind: 'REGISTERED' },
      select: { id: true, borrowerId: true },
    })

    if (rivals.length === 0) return

    const rivalIds = rivals.map((rival) => rival.id)

    await tx.loan.updateMany({
      where: {
        id: { in: rivalIds },
        status: 'REQUESTED',
        origin: 'REQUESTED',
        borrowerKind: 'REGISTERED',
      },
      data: { status: 'REJECTED', respondedAt: now },
    })

    const rejected = await tx.loan.findMany({
      where: { id: { in: rivalIds }, status: 'REJECTED', respondedAt: now },
      select: { id: true, borrowerId: true },
    })

    if (rejected.length !== rivals.length) {
      throw new Error(
        `Конкурентні запити на ${copyId} змінилися під блокуванням при створенні гостьової позики: ` +
          `прочитано ${String(rivals.length)}, відхилено ${String(rejected.length)}`,
      )
    }

    for (const rival of rejected) {
      if (rival.borrowerId === null) {
        throw new Error(`Лоан ${rival.id}: REQUESTED без зареєстрованого позичальника`)
      }

      await this.notifications.create(
        {
          userId: rival.borrowerId,
          type: 'LOAN_REJECTED',
          payload: { loanId: rival.id, copyId, actorId },
        },
        tx,
      )
    }
  }

  /**
   * `PATCH /loans/guest/:id { action, effectiveAt? }` — `return`/`mark_lost`/`recover`/`close_loss`.
   *
   * §6.11.2: локувальний запит той самий для всіх чотирьох дій (лок на `Copy` через `join` з
   * `Loan`, авторизація — `ownerId` у самому запиті). `recover`/`close_loss` додатково локають сам
   * рядок `Loan` — спільна точка серіалізації між ними (два часткові унікальні індекси на різні
   * `type` цього самого по собі не забезпечують).
   */
  async apply(
    ownerId: string,
    id: string,
    request: UpdateGuestLoanRequest,
  ): Promise<GuestLoanResponse> {
    let loan: GuestLoanRow

    try {
      loan = await this.prisma.$transaction((tx) => this.applyTransition(tx, ownerId, id, request))
    } catch (error) {
      // Гонка на INSERT повз перевірку під локом (§6.11.2 плану) — друга лінія оборони, той самий
      // принцип, що для реєстрованого `recover` (§6.6).
      if (isUniqueViolationOn(error, ONE_RECOVERY_PER_LOAN)) throw alreadyRecoveredError()
      if (isUniqueViolationOn(error, ONE_LOSS_CLOSURE_PER_LOAN)) throw alreadyClosed()

      throw error
    }

    this.logger.log(`Гостьова позика ${loan.id}: дія ${request.action}, власник ${ownerId}`)
    this.notifications.dispatchSoon()

    return { loan: toGuestLoan(loan) }
  }

  private async applyTransition(
    tx: TransactionClient,
    ownerId: string,
    id: string,
    request: UpdateGuestLoanRequest,
  ): Promise<GuestLoanRow> {
    // 0. Stage 10 (10h): `return`/`mark_lost`/`recover`/`close_loss` тепер теж пишуть
    //    ExternalBorrower.retainUntil (крок 4 нижче) — і мусять тому теж дотримуватись
    //    глобального порядку локів `ExternalBorrower → Copy → Loan` (§6.11.2), а не брати EB
    //    ПІСЛЯ Copy/Loan (це дало б порядок Copy → Loan → EB — зворотний до DELETE і цикл
    //    очікування, `retention.ts` docstring). Неlocований пошук лише вирішує, ЯКИЙ контакт
    //    locати першим — не авторизує нічого сам: авторитетна перевірка лишається кроком 2
    //    нижче (Copy-через-Loan join), як і раніше.
    const [lookup] = await tx.$queryRaw<{ borrowerContactId: string | null }[]>`
      SELECT "borrowerContactId" FROM "Loan"
      WHERE "id" = ${id} AND "ownerId" = ${ownerId}
        AND "origin" = 'RECORDED_GUEST' AND "borrowerKind" = 'GUEST'
    `
    const contactId = lookup?.borrowerContactId ?? null

    // 1. ExternalBorrower — locується ПЕРШИМ, коли позика досі вказує на контакт (не після
    //    DELETE, Q3c). Авторизація (ownerId) вбудована в сам запит; відсутній рядок (чужий
    //    контакт чи контакт, щойно стертий конкурентним DELETE) — не помилка тут: крок 4 нижче
    //    просто не знайде контакту й пропустить перерахунок.
    if (contactId !== null) {
      await tx.$queryRaw`
        SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${contactId} AND "ownerId" = ${ownerId} FOR UPDATE
      `
    }

    // 2. Copy — локується через JOIN з Loan, той самий патерн, що в registered `runTransition`
    //    (loan.service.ts:600-608). Авторизація (ownerId) **і** межа валідних гостьових статусів
    //    (GUEST_LOAN_ROW/GUEST_LOAN_STATUSES — CHECK `loan_borrower_kind_valid` статус не обмежує)
    //    застосовані ТУТ, у самому локувальному запиті: чужа, неіснуюча чи синтетична позика з
    //    неможливим статусом (`REQUESTED`/`APPROVED`/… для `borrowerKind='GUEST'`) однаково не
    //    дають рядка — лок не береться, PATCH не мутує нічого.
    const [locked] = await tx.$queryRaw<CopyLockRow[]>`
      SELECT c."id" AS "copyId"
      FROM "Loan" l
      JOIN "Copy" c ON c."id" = l."copyId"
      WHERE l."id" = ${id} AND l."origin" = 'RECORDED_GUEST' AND l."borrowerKind" = 'GUEST'
        AND l."status" IN ('HANDED_OVER', 'RETURNED', 'LOST') AND l."handedAt" IS NOT NULL
        AND l."ownerId" = ${ownerId}
      FOR UPDATE OF c
    `

    if (locked === undefined) throw notFoundLoan()

    // 3. Перечитування ПІСЛЯ локу — обов'язково (§6.11.2): рішення на знімку до очікування було б
    //    застарілим, якщо конкурент саме встиг завершити свій перехід, поки ми чекали.
    const loanRow = await tx.loan.findUnique({ where: { id }, include: WITH_GUEST_CONTEXT })
    const copy = await tx.copy.findUnique({ where: { id: locked.copyId } })

    if (loanRow === null || copy === null) throw notFoundLoan()

    const loan = requireGuestRow(loanRow)
    // Той самий диспетчер, що `LoanService.runTransition` (§7 рев'ю 10f.3, `resolveLoanTransition`
    // у `loan.transitions.ts`) — не окрема, паралельна точка рішення.
    const decision = resolveLoanTransition({
      kind: 'GUEST',
      from: loan.status,
      action: request.action,
    })
    const outcome = decision.result

    if ('kind' in outcome) {
      throw new ApiException(
        API_ERROR_CODES.LOAN_INVALID_TRANSITION,
        'Дія неможлива в поточному стані гостьової позики',
        HttpStatus.CONFLICT,
      )
    }

    // 4. `recover`/`close_loss`: додатковий, явний лок САМЕ рядка `Loan` — спільний для обох дій,
    //    незалежно від того, яка з них також торкається `Copy`. Це і є точка серіалізації
    //    `recover ∥ close_loss` (§6.11.2): без неї два часткові унікальні індекси на різні `type`
    //    не гарантують, що одна дія побачить факт закінченої іншої.
    if (outcome.event === 'RECOVERED' || outcome.event === 'LOSS_CLOSED') {
      await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id" = ${id} FOR UPDATE`

      const alreadyRecovered = await tx.loanEvent.findFirst({
        where: { loanId: id, type: 'RECOVERED' },
        select: { id: true },
      })
      const alreadyClosedLoss = await tx.loanEvent.findFirst({
        where: { loanId: id, type: 'LOSS_CLOSED' },
        select: { id: true },
      })

      // Q3c (§0.7.1): `close_loss` блокується попередньою подією БУДЬ-ЯКОГО з двох типів; `recover`
      // — лише попередньою `RECOVERED` (та сама однократність, що для реєстрованого recover, §6.6).
      if (outcome.event === 'RECOVERED' && alreadyRecovered !== null) throw alreadyRecoveredError()
      if (
        outcome.event === 'LOSS_CLOSED' &&
        (alreadyRecovered !== null || alreadyClosedLoss !== null)
      ) {
        throw alreadyClosed()
      }
    }

    let effectiveAt: Date | undefined

    if (outcome.event === 'RECOVERED') {
      effectiveAt = assertRecoveryDate(request.effectiveAt, new Date())

      if (copy.archivedAt !== null) {
        throw new ApiException(
          API_ERROR_CODES.COPY_ARCHIVED,
          'Примірник в архіві: спершу відновіть його з архіву',
          HttpStatus.CONFLICT,
        )
      }

      // Той самий захист, що `assertRecoverable` в `LoanService` (10d, §6.6): стан примірника міг
      // зайняти інша позика в обхід стейт-машини. Структурно недосяжно для `Copy` вже в UNAVAILABLE
      // (жоден новий реєстрований лоан на нього не стартує), але це другий, дешевий рубіж захисту.
      const occupied = await tx.loan.findFirst({
        where: {
          copyId: copy.id,
          id: { not: loan.id },
          status: { in: [...EXCLUSIVE_LOAN_STATUS] },
        },
        select: { id: true },
      })

      if (occupied !== null) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
          'Примірник зайнятий іншою позикою — відновлення неможливе',
          HttpStatus.CONFLICT,
        )
      }
    }

    // 5. Структурна передумова на Copy (§6.11.2, розширена модель тримача для гостя) — усі три
    //    умови обов'язкові, жодна не замінює іншу:
    //    (a) Copy.status у стані, якого вимагає перехід;
    //    (b) currentHolderId === null — гостя ніколи не тримає зареєстрований користувач, тож
    //        ненульовий currentHolderId завжди означає зіпсовані дані, НАВІТЬ якщо
    //        heldByContactId/borrowerContactId «збігаються» (обидва null після DELETE контакту).
    //        Без цієї явної перевірки стара гостьова LOST-позика з видаленим контактом (обидва
    //        contact-поля null) помилково пройшла б recovery і тоді, коли Copy насправді вже
    //        тримає зареєстрований позичальник ІНШОЇ, пізнішої позики — Copy для двох різних
    //        втрачених позик одночасно бути не може, а `currentHolderId ≠ null` для гостьового
    //        рядка це і є сигнал, що дані розійшлися;
    //    (c) heldByContactId цього Copy === borrowerContactId цієї позики, `IS NOT DISTINCT
    //        FROM`-порівнянням: обидва можуть бути NULL після DELETE контакту (D3/Q3d) —
    //        recovery не має вимагати, щоб контакт досі існував.
    if (outcome.requiresCopyStatus !== null) {
      const holderIsNull = copy.currentHolderId === null
      const contactMatches = sameOrBothNull(copy.heldByContactId, loanRow.borrowerContactId)

      if (copy.status !== outcome.requiresCopyStatus || !holderIsNull || !contactMatches) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
          'Стан примірника змінився — оновіть сторінку',
          HttpStatus.CONFLICT,
        )
      }
    }

    if (outcome.to !== loan.status) {
      const updated = await tx.loan.updateMany({
        where: { id: loan.id, status: loan.status },
        data: {
          status: outcome.to,
          ...(outcome.stamp === null ? {} : { [outcome.stamp]: new Date() }),
        },
      })

      assertSingleRow(updated.count)
    }

    if (outcome.copyStatus !== null || outcome.copyHolder !== null) {
      const changed = await tx.copy.updateMany({
        where: { id: copy.id, status: copy.status, heldByContactId: copy.heldByContactId },
        data: {
          status: outcome.copyStatus ?? undefined,
          currentHolderId: outcome.copyHolder === 'OWNER' ? ownerId : undefined,
          heldByContactId: outcome.copyHolder === 'OWNER' ? null : undefined,
        },
      })

      assertSingleRow(changed.count)
    }

    await this.loanEvents.record(tx, {
      loanId: loan.id,
      type: outcome.event,
      actorId: ownerId,
      effectiveAt,
    })

    // 6. Stage 10 (10h, §0.7/§0.7.1/§0.9 execution plan): перерахунок retainUntil у ТІЙ САМІЙ
    //    транзакції, що й перехід (§6.11: «значення перераховується в тій самій транзакції, що й
    //    відповідний перехід»). `loanRow.borrowerContactId` — стан ПІСЛЯ перечитування кроком 3,
    //    жоден з чотирьох переходів це поле не змінює, тож воно й лишається актуальним тут; `null`
    //    означає, що контакт уже стерто чисткою до цього виклику (Q3c) — перераховувати нічого.
    if (loanRow.borrowerContactId !== null) {
      await recomputeRetainUntil(tx, loanRow.borrowerContactId)
    }

    return requireGuestRow(
      await tx.loan.findUniqueOrThrow({ where: { id: loan.id }, include: WITH_GUEST_CONTEXT }),
    )
  }
}

/**
 * Stage 10 (10d), той самий рядок, що в `LoanService` (`loan.service.ts:55`) — заведений у міграції
 * M4 руками, тож і тут рядком.
 */
const ONE_RECOVERY_PER_LOAN = 'one_recovery_per_loan'

/**
 * Прив'язка Prisma-клієнта транзакції — той самий звужений перелік, що в `LoanService`
 * (`loan.service.ts`), лише без `friendship` (гостьова позика дружбу не перевіряє). `user` і
 * `notificationPreference` потрібні саме `NotificationsService.create`, а не логіці цього файлу.
 */
type TransactionClient = Pick<
  PrismaService,
  | 'loan'
  | 'loanEvent'
  | 'copy'
  | 'externalBorrower'
  | 'notification'
  | 'notificationDelivery'
  | 'notificationPreference'
  | 'user'
  | '$queryRaw'
>

/**
 * Друга лінія захисту (§6.2.3 review): якщо `GUEST_LOAN_ROW`/лок-запит колись розійдуться з
 * `GUEST_LOAN_STATUSES`, ця функція падає гучно замість того, щоб мовчки віддати клієнту статус,
 * якого гостьова позика мати не повинна.
 */
function requireGuestRow(row: UnvalidatedGuestLoanRow): GuestLoanRow {
  const guestLoan = asGuestLoan(row)

  if (guestLoan === null) {
    throw new Error(
      'Очікувалась гостьова позика з допустимим статусом (HANDED_OVER/RETURNED/LOST) і handedAt ' +
        '— фільтр читача мав це виключити',
    )
  }

  return guestLoan
}

function sameOrBothNull(one: string | null, other: string | null): boolean {
  return one === other
}

export function assertSingleRow(count: number): void {
  if (count !== 1) {
    throw new ApiException(
      API_ERROR_CODES.CONFLICT,
      'Позичання щойно змінив хтось інший — оновіть сторінку',
      HttpStatus.CONFLICT,
    )
  }
}

/** Фактична дата передачі — початок доби UTC (день без часу, як у `LoanService`). */
export function toHandedDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Той самий принцип, що `assertRecordDates` у `LoanService` (10e): не в майбутньому, не раніше передачі. */
export function assertGuestLoanDates(handedOn: string, dueOn: string | null, now: Date): void {
  if (handedOn > now.toISOString().slice(0, 10) || (dueOn !== null && dueOn < handedOn)) {
    throw new ApiException(
      API_ERROR_CODES.LOAN_RECORD_DATE_INVALID,
      'Дата передачі не може бути в майбутньому, а строк повернення — раніше за дату передачі',
      HttpStatus.BAD_REQUEST,
    )
  }
}

/** Той самий принцип, що `assertRecoverable` у `LoanService` (10d): дата знахідки не в майбутньому. */
function assertRecoveryDate(effectiveAt: string | undefined, now: Date): Date {
  if (effectiveAt !== undefined && effectiveAt > now.toISOString().slice(0, 10)) {
    throw new ApiException(
      API_ERROR_CODES.LOAN_RECOVERY_DATE_INVALID,
      'Дата знахідки не може бути в майбутньому',
      HttpStatus.BAD_REQUEST,
    )
  }

  return effectiveAt === undefined ? now : new Date(`${effectiveAt}T00:00:00.000Z`)
}

function alreadyRecoveredError(): ApiException {
  return new ApiException(
    API_ERROR_CODES.LOAN_ALREADY_RECOVERED,
    'Знахідку вже зафіксовано для цього позичання',
    HttpStatus.CONFLICT,
  )
}

function alreadyClosed(): ApiException {
  return new ApiException(
    API_ERROR_CODES.LOAN_ALREADY_CLOSED,
    'Втрату вже закрито для цього позичання',
    HttpStatus.CONFLICT,
  )
}

export function copyUnavailable(): ApiException {
  return new ApiException(
    API_ERROR_CODES.LOAN_COPY_UNAVAILABLE,
    'Цей примірник зараз не можна записати як позичений: він не вільний і не вдома',
    HttpStatus.CONFLICT,
  )
}

export function notFoundCopy(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Примірника не знайдено', HttpStatus.NOT_FOUND)
}

export function notFoundContact(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Контакт не знайдено', HttpStatus.NOT_FOUND)
}

export function notFoundLoan(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Позичання не знайдено', HttpStatus.NOT_FOUND)
}
