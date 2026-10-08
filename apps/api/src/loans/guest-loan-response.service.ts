import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type AnswerGuestResponseRequest,
  type AnswerGuestResponseResponse,
  type RequestGuestCodeRequest,
  type RequestGuestCodeResponse,
  type ResolveGuestResponseResponse,
  type VerifyGuestCodeRequest,
  type VerifyGuestCodeResponse,
} from '@bookswap/shared'
import { generateToken, hashToken } from '../auth/tokens'
import { ApiException } from '../common/api.exception'
import { DevEmailSender } from '../email/dev-email-sender'
import { recomputeRetainUntil } from '../external-borrowers/retention'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { GuestConfirmationSecrets } from './guest-confirmation-secrets'
import {
  CLEARED_CHALLENGE,
  CLEARED_LINK_AND_CHALLENGE,
  GUEST_CODE_MAX_ATTEMPTS,
  GUEST_CODE_MAX_FAILED_TOTAL,
  GUEST_CODE_MAX_SENDS_PER_WINDOW,
  GUEST_CODE_SEND_WINDOW_MS,
  GUEST_CODE_TTL_MS,
  GUEST_PROOF_TTL_MS,
} from './guest-confirmation.rules'
import type { TransactionClient } from './guest-loan-confirmation.service'
import { assertSingleRow, GuestLoanService } from './guest-loan.service'
import { LoanEventService } from './loan-event.service'
import type { GuestLoanConfirmationModel } from '../generated/prisma/models'

/**
 * Що знаходить публічний запит за токеном: лише те, що потрібно вирішити, які ресурси locати.
 * Нелокований пошук нічого не авторизує — кожна дія перевіряє все ще раз на ЛОКОВАНОМУ рядку.
 */
interface TokenLookup {
  id: string
  loanId: string
  externalBorrowerId: string | null
  loan: { copyId: string; ownerId: string }
}

/** Результат транзакції: помилки, після яких ЗМІНИ МАЮТЬ ЗАКОМІТИТИСЬ (лічильники спроб), кидаються поза нею. */
type Failure =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'code_invalid' }
  | { kind: 'rate_limited' }
  | { kind: 'proof_invalid' }

/**
 * Stage 10 (10i.2, §0.10–§0.13, §6.12): ПУБЛІЧНА гостьова відповідь на конкретну позику — без акаунта
 * `User`. Чотири кроки: `resolve` (що підтверджується) → `requestCode` (одноразовий шестизначний код на
 * адресу гостя B) → `verifyCode` (доказ контролю B) → `answer` («Отримав книжку» / «Не отримував», один раз).
 *
 * Що це доводить: відповідь через посилання ПІСЛЯ підтвердження контролю введеної адреси B. Посилання
 * можна передати іншій людині — особу первісного адресата це не доводить (§0.12 п. 4). Адреса доставки
 * листа власника (A) тут не фігурує й з B не порівнюється.
 *
 * Приватність: нікнейм і B живуть у БД лише як HMAC (`challengeMac`) до відповіді; після доведеної
 * відповіді пишуться ВИКЛЮЧНО в `ExternalBorrower` (приватно, разом із часом перевірки). Ні `Loan`, ні
 * `LoanEvent`, ні логи, ні відповіді цих маршрутів їх не містять. D2: лист іде лише через
 * `DevEmailSender` (запечатаний — секрет не потрапляє в лог), реальний провайдер не викликається.
 *
 * Порядок локів для `answer`: `ExternalBorrower → Copy → Loan → GuestLoanConfirmation` (§6.11.2), як в усіх
 * інших операціях. `requestCode`/`verifyCode` торкаються ЛИШЕ рядка підтвердження (останній ресурс
 * порядку), тож із рештою цикл неможливий.
 */
@Injectable()
export class GuestLoanResponseService {
  private readonly logger = new Logger(GuestLoanResponseService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly loanEvents: LoanEventService,
    private readonly guestLoans: GuestLoanService,
    private readonly notifications: NotificationsService,
    private readonly secrets: GuestConfirmationSecrets,
    private readonly devEmail: DevEmailSender,
  ) {}

  /** `POST /guest-loan-responses/resolve`: книжка й строк — без email, alias власника чи історії. */
  async resolve(token: string): Promise<ResolveGuestResponseResponse> {
    const row = await this.prisma.guestLoanConfirmation.findUnique({
      where: { linkTokenHash: hashToken(token) },
      include: {
        loan: {
          include: {
            copy: {
              include: {
                edition: {
                  include: { work: { include: { authors: { include: { author: true } } } } },
                },
              },
            },
          },
        },
      },
    })

    if (row === null || row.status !== 'OPEN' || row.linkExpiresAt === null) throw linkInvalid()

    if (row.linkExpiresAt.getTime() <= Date.now()) throw linkExpired()

    const { work } = row.loan.copy.edition

    return {
      book: { title: work.title, authors: work.authors.map((entry) => entry.author.name) },
      expiresAt: row.linkExpiresAt.toISOString(),
    }
  }

  /** `POST /guest-loan-responses/code`. */
  async requestCode(request: RequestGuestCodeRequest): Promise<RequestGuestCodeResponse> {
    const lookup = await this.findByToken(request.token)
    const code = this.secrets.generateCode()
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwnRow(tx, lookup.id, request.token)

      if ('kind' in locked) return locked

      const { row, now } = locked

      if (row.codeFailedTotal >= GUEST_CODE_MAX_FAILED_TOTAL)
        return { kind: 'rate_limited' as const }

      // Вікно листів на посилання: не більше N кодів за годину — це й обмеження розсилки на адресу B.
      const windowOpen =
        row.codeWindowStartedAt !== null &&
        now.getTime() - row.codeWindowStartedAt.getTime() < GUEST_CODE_SEND_WINDOW_MS
      const sent = windowOpen ? row.codeSentCount : 0

      if (sent >= GUEST_CODE_MAX_SENDS_PER_WINDOW) return { kind: 'rate_limited' as const }

      const mac = this.secrets.challengeMac(row.id, request.email, request.nickname)
      const codeHash = this.secrets.codeHash(row.id, mac, code)
      const codeNonce = this.secrets.generateNonce()
      const codeExpiresAt = new Date(now.getTime() + GUEST_CODE_TTL_MS)

      // Новий код замінює попередній виклик і будь-який попередній доказ (він прив'язаний до старого mac).
      await tx.guestLoanConfirmation.update({
        where: { id: row.id },
        data: {
          ...CLEARED_CHALLENGE,
          challengeMac: mac,
          codeHash,
          codeNonce,
          codeExpiresAt,
          codeSentCount: sent + 1,
          codeWindowStartedAt: windowOpen ? (row.codeWindowStartedAt ?? now) : now,
        },
      })

      return { kind: 'ok' as const, codeExpiresAt, id: row.id, codeNonce }
    })

    if (result.kind !== 'ok') throw failure(result)

    try {
      await this.devEmail.send({
        to: request.email,
        subject: 'BookSwap: код підтвердження email',
        body:
          `Код підтвердження: ${code}\n\n` +
          `Він дійсний ${String(GUEST_CODE_TTL_MS / 60_000)} хвилин і спрацьовує один раз. ` +
          'Якщо ви його не запитували, проігноруйте лист.',
        idempotencyKey: `guest-code:${result.id}:${result.codeNonce.slice(0, 16)}`,
        sealed: true,
      })
    } catch (error) {
      // Код, який ніхто не отримає, гасне одразу — лише ЦЯ видача: `codeNonce` — випадковий ідентифікатор
      // видачі, незалежний від коду. `codeHash` для цього не годиться: однакові шість цифр за тих самих
      // підтвердження/email/нікнейма дають той самий хеш. Якщо код уже замінено чи перевірено
      // (`codeNonce` інший/`NULL`), нічого не гаситься.
      await this.prisma.guestLoanConfirmation.updateMany({
        where: { id: result.id, codeNonce: result.codeNonce },
        data: CLEARED_CHALLENGE,
      })
      this.logger.warn(
        `Лист із кодом ${result.id} не надіслано: ${error instanceof Error ? error.name : 'помилка'}`,
      )

      throw new ApiException(
        API_ERROR_CODES.GUEST_LINK_EMAIL_FAILED,
        'Не вдалося надіслати лист із кодом. Спробуйте ще раз пізніше.',
        HttpStatus.BAD_GATEWAY,
      )
    }

    return { codeExpiresAt: result.codeExpiresAt.toISOString() }
  }

  /** `POST /guest-loan-responses/verify`. */
  async verifyCode(request: VerifyGuestCodeRequest): Promise<VerifyGuestCodeResponse> {
    const lookup = await this.findByToken(request.token)
    const proof = generateToken()
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwnRow(tx, lookup.id, request.token)

      if ('kind' in locked) return locked

      const { row, now } = locked

      if (row.codeFailedTotal >= GUEST_CODE_MAX_FAILED_TOTAL)
        return { kind: 'rate_limited' as const }

      // Немає чинного коду — вгадувати нічого; це не рахується спробою (лічильник не роздмухується
      // порожніми викликами), але й нічого не підтверджує.
      if (
        row.codeHash === null ||
        row.codeExpiresAt === null ||
        row.challengeMac === null ||
        row.codeExpiresAt.getTime() <= now.getTime()
      ) {
        return { kind: 'code_invalid' as const }
      }

      const mac = this.secrets.challengeMac(row.id, request.email, request.nickname)
      const matches =
        this.secrets.equal(mac, row.challengeMac) &&
        this.secrets.equal(this.secrets.codeHash(row.id, mac, request.code), row.codeHash)

      if (!matches) {
        const attempts = row.codeAttempts + 1

        // Хибна спроба комітиться (тому результат — значення, а не виняток усередині транзакції).
        await tx.guestLoanConfirmation.update({
          where: { id: row.id },
          data: {
            codeFailedTotal: row.codeFailedTotal + 1,
            ...(attempts >= GUEST_CODE_MAX_ATTEMPTS
              ? { ...CLEARED_CHALLENGE }
              : { codeAttempts: attempts }),
          },
        })

        return { kind: 'code_invalid' as const }
      }

      // Код одноразовий: успіх гасить його й видає доказ, прив'язаний до цього mac (адреса+нікнейм).
      const proofExpiresAt = new Date(now.getTime() + GUEST_PROOF_TTL_MS)

      await tx.guestLoanConfirmation.update({
        where: { id: row.id },
        data: {
          codeHash: null,
          codeExpiresAt: null,
          codeNonce: null,
          codeAttempts: 0,
          proofHash: hashToken(proof),
          proofExpiresAt,
          verifiedAt: now,
        },
      })

      return { kind: 'ok' as const, proofExpiresAt }
    })

    if (result.kind !== 'ok') throw failure(result)

    return { proof, proofExpiresAt: result.proofExpiresAt.toISOString() }
  }

  /** `POST /guest-loan-responses/answer`. */
  async answer(request: AnswerGuestResponseRequest): Promise<AnswerGuestResponseResponse> {
    const lookup = await this.findByToken(request.token)

    if (lookup.externalBorrowerId === null) throw linkInvalid()

    const result = await this.prisma.$transaction((tx) => this.applyAnswer(tx, lookup, request))

    if (result.kind !== 'ok') throw failure(result)

    this.logger.log(`Запит гостьового підтвердження ${lookup.id}: відповідь ${request.answer}`)

    if (request.answer === 'RECEIVED') this.notifications.dispatchSoon()

    return { answer: request.answer }
  }

  private async applyAnswer(
    tx: TransactionClient,
    lookup: TokenLookup,
    request: AnswerGuestResponseRequest,
  ): Promise<{ kind: 'ok' } | Failure> {
    const { loan: loanRef, id, externalBorrowerId } = lookup
    const ownerId = loanRef.ownerId

    if (externalBorrowerId === null) return { kind: 'invalid' }

    // 1. ExternalBorrower. 2. Copy. 3. Loan. 4. GuestLoanConfirmation — той самий порядок, що в усіх
    //    операціях над цим ланцюгом (§6.11.2). Авторизація — `ownerId` уже в кожному запиті.
    await tx.$queryRaw`
      SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${externalBorrowerId} AND "ownerId" = ${ownerId} FOR UPDATE
    `
    await tx.$queryRaw`
      SELECT "id" FROM "Copy" WHERE "id" = ${loanRef.copyId} AND "ownerId" = ${ownerId} FOR UPDATE
    `
    await tx.$queryRaw`
      SELECT "id" FROM "Loan" WHERE "id" = ${lookup.loanId} AND "ownerId" = ${ownerId} FOR UPDATE
    `

    const locked = await this.lockOwnRow(tx, id, request.token)

    if ('kind' in locked) return locked

    const { row, now } = locked

    // Доказ: чинний, не прострочений, для ЦІЄЇ адреси й ЦЬОГО нікнейма (mac). Випадковий 256-бітний
    // токен — перебору немає, тож лічильника тут не потрібно.
    const mac = this.secrets.challengeMac(row.id, request.email, request.nickname)

    if (
      row.proofHash === null ||
      row.proofExpiresAt === null ||
      row.verifiedAt === null ||
      row.challengeMac === null ||
      row.proofExpiresAt.getTime() <= now.getTime() ||
      !this.secrets.equal(hashToken(request.proof), row.proofHash) ||
      !this.secrets.equal(mac, row.challengeMac)
    ) {
      return { kind: 'proof_invalid' }
    }

    const loan = await tx.loan.findUnique({ where: { id: lookup.loanId } })
    const copy = await tx.copy.findUnique({ where: { id: loanRef.copyId } })

    // Структурна передумова (та сама, що в дій власника): розбіжність — зміна в обхід сервісу.
    if (
      loan === null ||
      copy === null ||
      loan.status !== 'PENDING_CONFIRMATION' ||
      loan.borrowerContactId !== externalBorrowerId ||
      copy.status !== 'RESERVED' ||
      copy.currentHolderId !== null ||
      copy.heldByContactId !== externalBorrowerId
    ) {
      throw new ApiException(
        API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
        'Стан позики змінився — зверніться до власника',
        HttpStatus.CONFLICT,
      )
    }

    const received = request.answer === 'RECEIVED'

    if (received) {
      const loanUpdated = await tx.loan.updateMany({
        where: { id: loan.id, status: 'PENDING_CONFIRMATION' },
        data: { status: 'HANDED_OVER' },
      })

      assertSingleRow(loanUpdated.count)

      const copyUpdated = await tx.copy.updateMany({
        where: { id: copy.id, status: 'RESERVED', heldByContactId: externalBorrowerId },
        data: { status: 'LENT_OUT' },
      })

      assertSingleRow(copyUpdated.count)

      // Підтверджене отримання відхиляє конкурентні `REQUESTED` (§0.13 п. 3); `actorId` — власник
      // примірника, від імені якого йде відмова. Заперечення їх не чіпає.
      await this.guestLoans.rejectRequestedRivals(tx, copy.id, ownerId, now)
    }

    // DENIED: `Loan` лишається `PENDING_CONFIRMATION`, `Copy` — `RESERVED`; вирішує власник (Q25).
    // CHECK `guest_loan_confirmation_resolved_at`: `resolvedAt` лише для завершених станів (RECEIVED).
    const confirmationUpdated = await tx.guestLoanConfirmation.updateMany({
      where: { id, status: 'OPEN' },
      data: {
        status: received ? 'RECEIVED' : 'DENIED',
        resolvedAt: received ? now : null,
        ...CLEARED_LINK_AND_CHALLENGE,
      },
    })

    assertSingleRow(confirmationUpdated.count)

    // Аудит: `actorId = null` (гість без акаунта), payload порожній — ні нікнейма, ні email.
    await this.loanEvents.record(tx, {
      loanId: loan.id,
      type: received ? 'GUEST_LOAN_RECEIVED' : 'GUEST_LOAN_DENIED',
      actorId: null,
    })

    // 10i.3: in-app-сповіщення власнику — в ТІЙ САМІЙ транзакції, що й відповідь: збій запису відкочує
    // усе. Лише id (позика, примірник, запит): ні нікнейма, ні email гостя тут немає й не буде. Один факт —
    // одна Notification; IN_APP + (за налаштуваннями) EMAIL — рядки доставок цієї ж Notification, Telegram
    // для типу недоступний (`GUEST_RESPONSE_NOTIFICATION_TYPE`). Лист рендериться загальним (renderer).
    await this.notifications.create(
      {
        userId: ownerId,
        type: received ? 'GUEST_LOAN_RECEIVED' : 'GUEST_LOAN_DENIED',
        payload: { loanId: loan.id, copyId: copy.id, confirmationId: id },
      },
      tx,
    )

    // Доведена відповідь (обидві) пишеться приватно в контакт і ЗАМІНЮЄ попередні гостьові значення;
    // alias власника не змінюється (§0.13 п. 1, Q27). Час — момент перевірки коду, не відповіді.
    await tx.externalBorrower.update({
      where: { id: externalBorrowerId },
      data: {
        guestNickname: request.nickname.trim(),
        guestEmail: request.email.trim().toLowerCase(),
        guestEmailVerifiedAt: row.verifiedAt,
      },
    })

    await recomputeRetainUntil(tx, externalBorrowerId)

    return { kind: 'ok' }
  }

  /**
   * Пошук за токеном — нелокований, лише щоб знати, які ресурси locати. Невідомий, замінений, погашений
   * відповіддю чи дією власника токен — однаково `GUEST_LINK_INVALID` (за токеном не видно, який саме).
   */
  private async findByToken(token: string): Promise<TokenLookup> {
    const row = await this.prisma.guestLoanConfirmation.findUnique({
      where: { linkTokenHash: hashToken(token) },
      select: {
        id: true,
        loanId: true,
        externalBorrowerId: true,
        loan: { select: { copyId: true, ownerId: true } },
      },
    })

    if (row === null) throw linkInvalid()

    return row
  }

  /**
   * Лок рядка підтвердження й ПОВТОРНА перевірка токена/статусу/строку на локованому стані: між
   * нелокованим пошуком і локом токен могли замінити, а запит — розв'язати. Повертає свіжий рядок або
   * `Failure`. Строк лінку — за серверним часом ПІСЛЯ локу, сплив нічого не змінює в `Loan`/`Copy`.
   */
  private async lockOwnRow(
    tx: TransactionClient,
    id: string,
    token: string,
  ): Promise<{ row: GuestLoanConfirmationModel; now: Date } | Failure> {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "GuestLoanConfirmation" WHERE "id" = ${id} FOR UPDATE
    `

    if (locked === undefined) return { kind: 'invalid' }

    // Час перевірки — ПІСЛЯ отримання локу: посилання/код/доказ, що спливли, поки запит чекав, не проходять.
    const now = new Date()
    const row = await tx.guestLoanConfirmation.findUniqueOrThrow({ where: { id } })

    if (
      row.status !== 'OPEN' ||
      row.linkTokenHash === null ||
      row.linkExpiresAt === null ||
      !this.secrets.equal(row.linkTokenHash, hashToken(token))
    ) {
      return { kind: 'invalid' }
    }

    if (row.linkExpiresAt.getTime() <= now.getTime()) return { kind: 'expired' }

    return { row, now }
  }
}

function failure(result: Failure): ApiException {
  switch (result.kind) {
    case 'invalid':
      return linkInvalid()
    case 'expired':
      return linkExpired()
    case 'code_invalid':
      return new ApiException(
        API_ERROR_CODES.GUEST_CODE_INVALID,
        'Код хибний, прострочений або вже використаний',
        HttpStatus.BAD_REQUEST,
      )
    case 'rate_limited':
      return new ApiException(
        API_ERROR_CODES.GUEST_CODE_RATE_LIMITED,
        'Забагато спроб для цього посилання. Зверніться до власника по нове посилання.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    case 'proof_invalid':
      return new ApiException(
        API_ERROR_CODES.GUEST_PROOF_INVALID,
        'Спершу підтвердіть контроль над адресою кодом із листа',
        HttpStatus.FORBIDDEN,
      )
  }
}

function linkInvalid(): ApiException {
  return new ApiException(
    API_ERROR_CODES.GUEST_LINK_INVALID,
    'Посилання недійсне або вже використане',
    HttpStatus.NOT_FOUND,
  )
}

function linkExpired(): ApiException {
  return new ApiException(
    API_ERROR_CODES.GUEST_LINK_EXPIRED,
    'Строк дії посилання минув — попросіть власника видати нове',
    HttpStatus.GONE,
  )
}
