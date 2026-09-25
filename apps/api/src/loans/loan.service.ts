import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  EXCLUSIVE_LOAN_STATUS,
  type CreateLoanRequest,
  type LoanAction,
  type LoanListResponse,
  type LoanQueryRequest,
  type LoanResponse,
  type LoanStatus,
  type UpdateLoanRequest,
} from '@bookswap/shared'
import { AccessService, blocked } from '../access/access.service'
import { copyVisibleTo } from '../access/visibility'
import { AnalyticsService } from '../analytics/analytics.service'
import type { ProductEventType } from '../analytics/product-event.types'
import { ApiException } from '../common/api.exception'
import { isUniqueViolationOn } from '../common/prisma-errors'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS } from '../users/user.mapper'
import {
  asRequestFlowLoan,
  toDueDate,
  toLoan,
  type LoanRow,
  type StoredLoanRow,
  type RequestFlowLoan,
} from './loan.mapper'
import {
  resolveTransition,
  type LoanActor,
  type LoanHolder,
  type LoanRefusal,
  type LoanTransition,
} from './loan.transitions'
import type { CopyModel, LoanWhereInput } from '../generated/prisma/models'

/**
 * Назва часткового унікального індексу зі §5.3.1. Заведена в першій міграції
 * руками, поза знанням Prisma, тож і тут вона рядком.
 */
export const ONE_ACTIVE_LOAN_PER_COPY = 'one_active_loan_per_copy'

/** Каталожний контекст лоану — рівно те, що читає `loan.mapper`. */
const WITH_CONTEXT = {
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
  owner: { select: PUBLIC_USER_FIELDS },
  borrower: { select: PUBLIC_USER_FIELDS },
} as const

/**
 * Stage 10 (T1): цей сервіс веде лише позики request-flow. Гостьові й записані власником
 * (`origin ≠ REQUESTED`) отримають власні шляхи в кроках 10e/10f, а тут не з'являються.
 */
const REQUEST_FLOW = { origin: 'REQUESTED', borrowerKind: 'REGISTERED' } as const

function requireRequestFlow<T extends StoredLoanRow>(row: T): RequestFlowLoan<T> {
  const flow = asRequestFlowLoan(row)

  if (flow === null)
    throw new Error('Очікувалась позика request-flow із зареєстрованим позичальником')

  return flow
}

/** Рядок, який повертає локувальний запит. Одне поле — більше й не треба. */
interface CopyLockRow {
  copyId: string
}

/** Усе, що потрібно для авто-відхилення конкурентів (§5.1). */
interface RivalContext {
  copyId: string
  /** Лоан, який щойно погодили: його самого відхиляти не можна. */
  approvedLoanId: string
  /** Власник, який натиснув «погодити», — саме він іде в `payload.actorId`. */
  actorId: string
  now: Date
}

/** Що саме сталося — для логу після коміту (§11). */
interface TransitionOutcome {
  loan: LoanRow
  from: LoanStatus
  to: LoanStatus
  rejectedRivalIds: string[]
}

type LoanProductEventType = Extract<
  ProductEventType,
  'LOAN_APPROVED' | 'LOAN_HANDED_OVER' | 'LOAN_RETURNED'
>

const LOAN_EVENT_BY_STATUS: Partial<Record<LoanStatus, LoanProductEventType>> = {
  APPROVED: 'LOAN_APPROVED',
  HANDED_OVER: 'LOAN_HANDED_OVER',
  RETURNED: 'LOAN_RETURNED',
}

/**
 * §5. Єдине місце, де змінюється `Loan.status`.
 *
 * Правило §5 сформульоване як «усі переходи — тільки через один сервісний метод»,
 * і тримається воно не обіцянкою, а структурою: рішення «чи можна» ухвалює чиста
 * `resolveTransition()` без доступу до бази, а всі записи йдуть крізь
 * `runTransition()`. Контролер, Telegram-бот і майбутні воркери дістаються сюди —
 * іншого шляху до `Loan.status` немає.
 */
@Injectable()
export class LoanService {
  private readonly logger = new Logger(LoanService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** §8: `GET /loans?role=owner|borrower&status=…`. Лише свої, з обох боків. */
  async list(userId: string, filters: LoanQueryRequest): Promise<LoanListResponse> {
    const sides: LoanWhereInput[] = []

    if (filters.role !== 'borrower') sides.push({ ownerId: userId })
    if (filters.role !== 'owner') sides.push({ borrowerId: userId })

    const rows = await this.prisma.loan.findMany({
      where: {
        OR: sides,
        ...REQUEST_FLOW,
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      include: WITH_CONTEXT,
      orderBy: { requestedAt: 'desc' },
    })

    const now = new Date()

    return { loans: rows.map((row) => toLoan(requireRequestFlow(row), now)) }
  }

  /**
   * §8: `GET /loans/:id`.
   *
   * Чужий лоан — 404, а не 403: маршрут не має повідомляти, які id існують у базі.
   * Той самий вибір, що в `PATCH /friends/requests/:id`.
   */
  async get(userId: string, loanId: string): Promise<LoanResponse> {
    const stored = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: WITH_CONTEXT,
    })
    const loan = stored === null ? null : asRequestFlowLoan(stored)

    if (loan === null || !isParticipant(loan, userId)) throw notFound('Позичання не знайдено')

    return { loan: toLoan(loan) }
  }

  /**
   * §5.1, рядок «— → REQUESTED».
   *
   * Транзакція з блокуванням рядка `Copy` потрібна й тут, хоч запит примірника не
   * змінює: без неї перевірка «книжка вільна» відповідає на питання про минуле —
   * між нею й `INSERT` власник встигає апрувнути когось іншого.
   */
  async request(borrowerId: string, request: CreateLoanRequest): Promise<LoanResponse> {
    const loan = await this.prisma.$transaction(async (tx) => {
      await this.lockCopy(tx, request.copyId)

      const copy = await tx.copy.findUnique({
        where: { id: request.copyId },
        select: {
          id: true,
          ownerId: true,
          currentHolderId: true,
          status: true,
          visibility: true,
          owner: { select: { libraryVisibility: true } },
        },
      })

      if (copy === null) throw notFound('Примірника не знайдено')

      // §5.3.4 і §5.2: позичити в самого себе не можна. Перевірка перша, бо решта
      // питань («чи ми друзі», «чи видно») для власного примірника безглузді.
      if (copy.ownerId === borrowerId) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_SELF,
          'Це ваш власний примірник',
          HttpStatus.BAD_REQUEST,
        )
      }

      const role = await this.access.roleOf(borrowerId, copy.ownerId, tx)

      if (role === 'BLOCKED') throw blocked()

      // §9: «Створити запит на позичання | Власник — | Друг ✓ | Інший ✗».
      // Саме ACCEPTED: запит у друзі дружбою не є.
      if (role !== 'FRIEND') {
        throw new ApiException(
          API_ERROR_CODES.FORBIDDEN,
          'Просити книжку можна лише в друзів',
          HttpStatus.FORBIDDEN,
        )
      }

      // §9: видимість примірника = найсуворіше з видимості бібліотеки та його
      // власної. Невидиме не існує — тому 404, а не 403.
      if (!copyVisibleTo(role, copy.owner.libraryVisibility, copy.visibility)) {
        throw notFound('Примірника не знайдено')
      }

      // §5.1: «Copy.status = AVAILABLE». Перевірка тримача не надлишкова попри
      // CHECK `copy_available_is_home`: вона виражає намір (книжка вдома), а не
      // покладається на те, що база десь поруч тримає той самий інваріант.
      //
      // Це ж і заборона ланцюгового позичання (§5.2): позичальник, у якого книжка
      // на руках, має `LENT_OUT`, тобто сюди не пройде — а `ownerId` нижче завжди
      // береться з `Copy`, тож видати чужу книжку далі неможливо й структурно.
      if (copy.status !== 'AVAILABLE' || copy.currentHolderId !== copy.ownerId) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_COPY_UNAVAILABLE,
          'Цей примірник зараз не можна попросити',
          HttpStatus.CONFLICT,
        )
      }

      // §5.1: «немає власного активного запиту». Чужі одночасні §5.2 дозволяє.
      const existing = await tx.loan.findFirst({
        where: { copyId: copy.id, borrowerId, status: 'REQUESTED' },
        select: { id: true },
      })

      if (existing !== null) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_DUPLICATE_REQUEST,
          'Ви вже просили цей примірник — запит чекає на відповідь',
          HttpStatus.CONFLICT,
        )
      }

      const created = await tx.loan.create({
        data: {
          copyId: copy.id,
          // §4.6: денормалізовано з `Copy` на момент створення — і тільки звідти.
          ownerId: copy.ownerId,
          borrowerId,
          message: request.message ?? null,
          dueAt: toDueDate(request.proposedDueAt),
        },
        include: WITH_CONTEXT,
      })

      // §7.3, правило 1: запис сповіщення — у тій самій транзакції.
      await this.notifications.create(
        {
          userId: copy.ownerId,
          type: 'LOAN_REQUESTED',
          payload: { loanId: created.id, copyId: copy.id, actorId: borrowerId },
        },
        tx,
      )

      return requireRequestFlow(created)
    })

    this.logger.log(`Лоан ${loan.id}: — → REQUESTED, актор ${borrowerId}`)

    // §7.3: «після коміту: подія». Тут, а не в `create`, бо всередині транзакції
    // «після коміту» не існує: поштовх, надісланий звідти, розбудив би диспетчер
    // на рядки, яких ще ніхто, крім цієї транзакції, не бачить.
    this.notifications.dispatchSoon()

    await this.analytics.record({
      type: 'LOAN_REQUESTED',
      subjectUserId: borrowerId,
      domainEntityId: loan.id,
      properties: {},
    })

    return { loan: toLoan(loan) }
  }

  /**
   * §8: `PATCH /loans/:id { action }` — усі шість переходів §5.1.
   *
   * Повтор при гонці не робиться (на відміну від `FriendsService`): тут вона
   * означає не «обидва хотіли того самого», а «книжку вже віддали іншому», і
   * правильна відповідь — сказати про це, а не тихо спробувати ще раз.
   *
   * Ловиться помилка **зовні** транзакції, і це не стилістика: порушення
   * обмеження перериває транзакцію Postgres цілком, тож будь-який наступний запит
   * у ній упав би з `25P02`.
   */
  async apply(actorId: string, loanId: string, request: UpdateLoanRequest): Promise<LoanResponse> {
    let outcome: TransitionOutcome

    try {
      outcome = await this.runTransition(actorId, loanId, request)
    } catch (error) {
      // Тільки свій індекс. Будь-який інший `P2002` летить далі незміненим:
      // сховати чуже порушення унікальності під доменним кодом означало б
      // упевнено збрехати клієнту про причину.
      if (isUniqueViolationOn(error, ONE_ACTIVE_LOAN_PER_COPY)) {
        throw new ApiException(
          API_ERROR_CODES.LOAN_ALREADY_APPROVED,
          'Цей примірник уже обіцяно іншій людині',
          HttpStatus.CONFLICT,
        )
      }

      throw error
    }

    // §11, логування переходів. ПІСЛЯ коміту, не всередині callback'а: лог,
    // записаний у транзакції, стверджував би, що перехід відбувся, навіть коли
    // її відкотили — і розслідування пішло б хибним слідом.
    this.logger.log(
      `Лоан ${outcome.loan.id}: ${outcome.from} → ${outcome.to}, актор ${actorId}` +
        (outcome.rejectedRivalIds.length === 0
          ? ''
          : `; авто-відхилено конкурентів: ${outcome.rejectedRivalIds.join(', ')}`),
    )

    // §7.3: «після коміту: подія». Один поштовх на весь перехід — авто-відхилення
    // конкурентів могло створити ще кілька сповіщень, і всі вони вже в базі.
    this.notifications.dispatchSoon()

    const productEventType = LOAN_EVENT_BY_STATUS[outcome.to]

    if (productEventType !== undefined) {
      await this.analytics.record({
        type: productEventType,
        subjectUserId: outcome.loan.borrower.id,
        domainEntityId: outcome.loan.id,
        properties: {},
      })
    }

    return { loan: toLoan(outcome.loan) }
  }

  private runTransition(
    actorId: string,
    loanId: string,
    request: UpdateLoanRequest,
  ): Promise<TransitionOutcome> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Блокування — ПЕРШИМ. Один запит одночасно знаходить рядок і бере лок
      //    на `Copy`, тож попереднього читання лоану поза транзакцією не існує:
      //    воно було б і неавторизованим, і застарілим до моменту запису.
      //
      //    Умова на сторони лоану стоїть **у самому локувальному запиті**, а не
      //    лише в перевірці нижче. Без неї будь-хто автентифікований, знаючи чужий
      //    `loanId`, ставав би в чергу за локом чужого `Copy` — і тримав би там
      //    справжніх учасників, поки його власна транзакція повзе до 404. Тобто
      //    авторизація відбувалася б **після** захоплення ресурсу; тут вона
      //    відбувається замість нього: не той актор — рядків нема, локу нема.
      const [locked] = await tx.$queryRaw<CopyLockRow[]>`
        SELECT c."id" AS "copyId"
        FROM "Loan" l
        JOIN "Copy" c ON c."id" = l."copyId"
        WHERE l."id" = ${loanId}
          AND l."origin" = 'REQUESTED' AND l."borrowerKind" = 'REGISTERED'
          AND (l."ownerId" = ${actorId} OR l."borrowerId" = ${actorId})
        FOR UPDATE OF c
      `

      // Чужий лоан і неіснуючий — однаково 404: інакше час відповіді сам
      // повідомляв би, які id існують у базі.
      if (locked === undefined) throw notFound('Позичання не знайдено')

      // 2. Перечитування ПІСЛЯ локу — обовʼязкове, і саме окремим запитом.
      //    `FOR UPDATE OF c` перечитує під EvalPlanQual лише заблоковану таблицю;
      //    рядок `Loan` лишився б зі снапшоту, взятого до очікування на локу. Тоді
      //    той, хто програв гонку апруву, побачив би свій лоан ще `REQUESTED` і
      //    спробував би апрувнути вже відхилений запит.
      const stored = await tx.loan.findUnique({ where: { id: loanId }, include: WITH_CONTEXT })
      const copy = await tx.copy.findUnique({ where: { id: locked.copyId } })
      const loan = stored === null ? null : asRequestFlowLoan(stored)

      if (loan === null || copy === null) throw notFound('Позичання не знайдено')

      // 3. Повторна перевірка сторін — на вже перечитаному рядку.
      //    Не дублювання умови з кроку 1: там вона захищала лок від чужого
      //    актора, а тут звіряється стан, прочитаний ПІСЛЯ очікування на локу.
      //    Між двома читаннями рядок міг змінитися, і рішення про перехід мусить
      //    спиратися на те, що ми справді бачимо зараз.
      if (!isParticipant(loan, actorId)) throw notFound('Позичання не знайдено')

      // 4. Структурні інваріанти §5.3. Їх порушення — не помилка користувача, а
      //    зіпсовані дані, тож і відповідь тут не доменна: краще гучне 500 і
      //    стектрейс у лозі, ніж 409, який виглядає як нормальний перебіг подій.
      assertStructure(loan, copy)

      // 5. Рішення ухвалює чиста функція. §5.1 і тільки вона.
      const actor: LoanActor = loan.ownerId === actorId ? 'OWNER' : 'BORROWER'
      const outcome = resolveTransition(loan.status, request.action, actor)

      if ('kind' in outcome) throw refusal(outcome.reason, request.action)

      // 6. Передумови на примірник — під локом, тобто на актуальному стані.
      this.assertCopyReady(outcome, loan, copy)

      const now = new Date()

      // 7. Умова на статус у самому UPDATE, а не перевіркою перед ним. Під локом
      //    `Copy` це надлишково, але робить неможливим тихий no-op, якщо колись
      //    хтось прибере блокування.
      const updated = await tx.loan.updateMany({
        where: { id: loan.id, status: loan.status },
        data: {
          status: outcome.to,
          responseNote: request.note ?? undefined,
          // §8: термін ставить власник на апруві; контролер уже відхилив `dueAt`
          // при будь-якій іншій дії.
          dueAt: request.dueAt === undefined ? undefined : toDueDate(request.dueAt),
          ...(outcome.stamp === null ? {} : { [outcome.stamp]: now }),
        },
      })

      assertSingleRow(updated.count)

      // 8. Побічні зміни примірника.
      if (outcome.copyStatus !== null || outcome.holder !== null) {
        const changed = await tx.copy.updateMany({
          where: { id: copy.id, status: copy.status, currentHolderId: copy.currentHolderId },
          data: {
            status: outcome.copyStatus ?? undefined,
            currentHolderId: outcome.holder === null ? undefined : holderIdOf(outcome.holder, loan),
          },
        })

        assertSingleRow(changed.count)
      }

      // 9. Авто-відхилення конкурентів (§5.1) — з іменами тих, кого справді змінили.
      const rejectedRivalIds = outcome.rejectRivals
        ? await this.rejectRivals(tx, {
            copyId: loan.copyId,
            approvedLoanId: loan.id,
            actorId,
            now,
          })
        : []

      // 10. Сповіщення — у ТІЙ САМІЙ транзакції (§7.3, правило 1).
      if (outcome.notify !== null) {
        await this.notifications.create(
          {
            userId: recipientOf(outcome.notify.to, loan, actor),
            type: outcome.notify.type,
            payload: { loanId: loan.id, copyId: loan.copyId, actorId },
          },
          tx,
        )
      }

      const after = requireRequestFlow(
        await tx.loan.findUniqueOrThrow({ where: { id: loan.id }, include: WITH_CONTEXT }),
      )

      return { loan: after, from: loan.status, to: outcome.to, rejectedRivalIds }
    })
  }

  /**
   * §5.1: «усі інші `REQUESTED` на цей примірник → `REJECTED`».
   *
   * Набір фіксується явно, а не виводиться з `count`: `updateMany` каже «скільки»,
   * але не «кого», а сповіщення адресні. Тому конкуренти спершу читаються, потім
   * оновлюються з умовою на статус, і аж потім перечитуються — щоб надіслати
   * `LOAN_REJECTED` рівно тим, чий рядок справді змінився.
   *
   * Під локом `Copy` набір не може змінитися між кроками: будь-який перехід
   * будь-якого лоану цього примірника проходить через той самий лок. Розбіжність
   * означала б, що припущення про блокування зламалося, — і тоді краще впасти, ніж
   * мовчки недорахувати сповіщень.
   */
  private async rejectRivals(tx: TransactionClient, context: RivalContext): Promise<string[]> {
    const { copyId, approvedLoanId, actorId, now } = context
    const rivals = await tx.loan.findMany({
      where: { copyId, status: 'REQUESTED', id: { not: approvedLoanId } },
      select: { id: true, borrowerId: true },
    })

    if (rivals.length === 0) return []

    const rivalIds = rivals.map((rival) => rival.id)

    await tx.loan.updateMany({
      where: { id: { in: rivalIds }, status: 'REQUESTED' },
      data: { status: 'REJECTED', respondedAt: now },
    })

    const rejected = await tx.loan.findMany({
      where: { id: { in: rivalIds }, status: 'REJECTED', respondedAt: now },
      select: { id: true, borrowerId: true },
    })

    if (rejected.length !== rivals.length) {
      throw new Error(
        `Конкурентні запити на ${copyId} змінилися під блокуванням: ` +
          `прочитано ${String(rivals.length)}, відхилено ${String(rejected.length)}`,
      )
    }

    for (const rival of rejected) {
      // `REQUESTED` існує лише в request-flow, де позичальник зареєстрований (`borrowerKind`
      // = REGISTERED ⇒ `borrowerId` NOT NULL, CHECK `loan_borrower_kind_valid`).
      if (rival.borrowerId === null) {
        throw new Error(`Лоан ${rival.id}: REQUESTED без зареєстрованого позичальника`)
      }

      await this.notifications.create(
        {
          userId: rival.borrowerId,
          type: 'LOAN_REJECTED',
          // `loanId` — саме ВІДХИЛЕНОГО лоану, а не апрувленого: сповіщення веде
          // людину до її власного запиту, до чужого вона не має доступу.
          // `actorId` — власник, який натиснув «погодити». Це поле §4.8 описує як
          // «хто зробив дію», і будь-що інше тут (наприклад id апрувленого лоану)
          // мовчки зіпсувало б payload: на етапі 3 він піде в текст листа й
          // Telegram, де «actorId» очікувано розгортається в ім'я людини.
          payload: { loanId: rival.id, copyId, actorId },
        },
        tx,
      )
    }

    return rejected.map((rival) => rival.id)
  }

  /** `SELECT … FOR UPDATE` на рядку `Copy` — §5.2 і §11 вимагають саме його. */
  private async lockCopy(tx: TransactionClient, copyId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Copy" WHERE "id" = ${copyId} FOR UPDATE`
  }

  /**
   * Передумови §5.1 на стан примірника.
   *
   * `requires === null` — не «будь-який стан підходить», а «цей перехід примірника
   * не стосується». Так описані `REQUESTED → REJECTED` і `REQUESTED → CANCELLED`:
   * прибрати висячий запит треба вміти й тоді, коли власник уже перемкнув книжку в
   * `UNAVAILABLE`, а «виправляти» його рішення назад ці переходи не мають права.
   */
  private assertCopyReady(
    transition: LoanTransition,
    loan: Pick<LoanRow, 'id'> & { ownerId: string; borrowerId: string },
    copy: Pick<CopyModel, 'status' | 'currentHolderId'>,
  ): void {
    if (transition.requires === null) return

    const expectedHolder = holderIdOf(transition.requires.holder, loan)

    if (copy.status === transition.requires.status && copy.currentHolderId === expectedHolder) {
      return
    }

    throw new ApiException(
      API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
      'Стан примірника змінився — оновіть сторінку',
      HttpStatus.CONFLICT,
    )
  }
}

/**
 * Прив'язка Prisma-клієнта транзакції: усі моделі плюс сирі запити.
 *
 * Моделі сповіщень тут не тому, що стейт-машина про них щось знає, а тому, що
 * `NotificationsService.create` пише в тій самій транзакції (§7.3, правило 1) —
 * і разом із подією складає рядки її доставки. Перелік звужений навмисно: він
 * показує, до чого перехід має право торкатися.
 */
type TransactionClient = Pick<
  PrismaService,
  | 'loan'
  | 'copy'
  | 'notification'
  | 'notificationDelivery'
  | 'notificationPreference'
  | 'user'
  | '$queryRaw'
>

interface LoanSides {
  ownerId: string
  borrowerId: string
}

function isParticipant(loan: LoanSides, userId: string): boolean {
  return loan.ownerId === userId || loan.borrowerId === userId
}

function holderIdOf(holder: LoanHolder, loan: LoanSides): string {
  return holder === 'OWNER' ? loan.ownerId : loan.borrowerId
}

function recipientOf(to: LoanActor | 'COUNTERPARTY', loan: LoanSides, actor: LoanActor): string {
  if (to === 'COUNTERPARTY') {
    return actor === 'OWNER' ? loan.borrowerId : loan.ownerId
  }

  return holderIdOf(to, loan)
}

/**
 * §5.3.4 і денормалізація §4.6.
 *
 * Обидва тримає БД (`loan_borrower_not_owner`) і код створення, тож зламатися це
 * може лише через правку даних руками. Перевірка тут — щоб такий рядок зупинився
 * до того, як стейт-машина почне переставляти на ньому володіння.
 */
function assertStructure(loan: LoanSides & { id: string }, copy: Pick<CopyModel, 'ownerId'>): void {
  if (loan.ownerId !== copy.ownerId) {
    throw new Error(`Лоан ${loan.id}: ownerId розійшовся з власником примірника`)
  }

  if (loan.ownerId === loan.borrowerId) {
    throw new Error(`Лоан ${loan.id}: позичальник збігається з власником (§5.3.4)`)
  }
}

function assertSingleRow(count: number): void {
  if (count !== 1) {
    throw new ApiException(
      API_ERROR_CODES.CONFLICT,
      'Позичання щойно змінив хтось інший — оновіть сторінку',
      HttpStatus.CONFLICT,
    )
  }
}

/**
 * Переклад відмови стейт-машини у відповідь HTTP.
 *
 * Тут і тільки тут: чиста машина не знає про HTTP, а контролер — про статуси.
 */
function refusal(reason: LoanRefusal, action: LoanAction): ApiException {
  if (reason === 'ROLE') {
    return new ApiException(
      API_ERROR_CODES.FORBIDDEN,
      `Дію «${action}» виконує інша сторона позичання`,
      HttpStatus.FORBIDDEN,
    )
  }

  return new ApiException(
    API_ERROR_CODES.LOAN_INVALID_TRANSITION,
    'Дія неможлива в поточному стані позичання',
    HttpStatus.CONFLICT,
  )
}

function notFound(message: string): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND)
}

// Компіляційна перевірка: множина зі `shared` збігається з тією, яку тримає
// частковий унікальний індекс. Якщо колись розійдуться — зламається тут.
const _exclusiveStatuses: readonly LoanStatus[] = EXCLUSIVE_LOAN_STATUS
void _exclusiveStatuses
