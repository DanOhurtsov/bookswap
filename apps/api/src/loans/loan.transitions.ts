import { isRecordAction } from '@bookswap/shared'
import type {
  CopyStatus,
  GuestLoanAction,
  LoanAction,
  LoanEventType,
  LoanOrigin,
  LoanStatus,
  NotificationType,
} from '@bookswap/shared'

/**
 * Стейт-машина позичання — таблиця §5.1 буквально. Чиста: ні Prisma, ні Nest, ні
 * винятків HTTP.
 *
 * Саме це робить архітектурне правило §5 технічно незламним. «Усі переходи через
 * один сервіс» — обіцянка, яку легко порушити наступним контролером; «рішення про
 * перехід ухвалює функція без доступу до бази» — властивість, яку порушити не
 * можна, не переписавши цей файл. Контролер, Telegram-бот і майбутні воркери
 * фізично не мають способу дійти до `Loan.status` в обхід.
 *
 * Побічний ефект, заради якого це й робиться: уся таблиця §5.1, включно з
 * негативними випадками, покривається unit-тестом без PostgreSQL.
 *
 * `LoanService` перекладає результат у записи й `ApiException`; більше ніхто не
 * має права дивитися на `Loan.status`.
 */

/** Бік лоану. Стороння людина сюди не доходить — її відсікає 404 у сервісі. */
export type LoanActor = 'OWNER' | 'BORROWER'

/** Куди вказує `Copy.currentHolderId` у термінах сторін лоану. */
export type LoanHolder = 'OWNER' | 'BORROWER'

/**
 * Стан примірника, який мусить бути правдою **до** переходу.
 *
 * Перевіряється під `SELECT … FOR UPDATE` на рядку `Copy`. `null` означає не
 * «будь-який», а «цей перехід примірника не стосується» — див. коментар до
 * `REJECTED`/`CANCELLED` нижче.
 */
export interface CopyPrecondition {
  status: CopyStatus
  holder: LoanHolder
}

export interface LoanNotification {
  to: LoanActor | 'COUNTERPARTY'
  type: NotificationType
}

export interface LoanTransition {
  to: LoanStatus
  /** Що мусить бути правдою до переходу; `null` — стан примірника не важить. */
  requires: CopyPrecondition | null
  /** `null` — `Copy.status` не чіпається. */
  copyStatus: CopyStatus | null
  /** `null` — `currentHolderId` не змінюється. */
  holder: LoanHolder | null
  /** `null` — жоден timestamp не проставляється. */
  stamp: 'respondedAt' | 'handedAt' | 'returnedAt' | null
  /** `null` — §5.1 сповіщення для цього рядка не передбачає. */
  notify: LoanNotification | null
  /** §5.1: усі інші `REQUESTED` на цей примірник → `REJECTED`. */
  rejectRivals: boolean
  /**
   * Stage 10 (T4): подія audit trail, яку перехід записує в тій самій транзакції. `null` — перехід
   * подій не пише (request-flow позики не отримують заднім числом вигаданих подій, §6.8).
   */
  event: LoanEventType | null
}

export type LoanRefusal =
  /** Такого рядка в таблиці §5.1 немає: дія неможлива з поточного статусу. */
  | 'STATE'
  /** Рядок є, але для іншої сторони. */
  | 'ROLE'

export type LoanTransitionResult = LoanTransition | { kind: 'refused'; reason: LoanRefusal }

const REFUSE = (reason: LoanRefusal): LoanTransitionResult => ({ kind: 'refused', reason })

/**
 * Єдине місце, де записано, що з чого можна.
 *
 * Порядок перевірок значущий: спершу статус, потім роль. Він визначає, яку саме
 * помилку побачить людина, і «дія неможлива в цьому стані» (409) точніше за
 * «вам не можна» (403) там, де дія вже неможлива нікому.
 */
export function resolveTransition(
  from: LoanStatus,
  action: LoanAction,
  actor: LoanActor,
  origin: LoanOrigin,
): LoanTransitionResult {
  // Stage 10 (10f): гостьові позики мають власні переходи в кроці 10f; тут їх немає.
  if (origin === 'RECORDED_GUEST') return REFUSE('STATE')

  // Stage 10 (10e, T3): записана власником позика має власну таблицю; request-flow дії над нею неможливі.
  if (origin === 'RECORDED_EXISTING') return resolveRecorded(from, action, actor)

  // І навпаки: дії запису над позикою request-flow неможливі.
  if (isRecordAction(action)) return REFUSE('STATE')

  switch (from) {
    case 'REQUESTED':
      return fromRequested(action, actor)
    case 'APPROVED':
      return fromApproved(action, actor)
    case 'HANDED_OVER':
      return fromHandedOver(action, actor, origin)
    case 'LOST':
      return fromLost(action, actor)
    // Три термінальні стани §5.1. З них не веде жоден перехід — ні для кого.
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
      return REFUSE('STATE')
    // Статуси запису наявної позики для позики request-flow недосяжні: такий рядок — зіпсовані дані.
    case 'PENDING_CONFIRMATION':
    case 'DECLINED':
      return REFUSE('STATE')
  }
}

/**
 * Stage 10 (10e, T3, D6): переходи позики `origin = RECORDED_EXISTING`. Статуси `REQUESTED`, `APPROVED`,
 * `REJECTED` для неї неможливі (синтетичний рядок не стає легітимним записом), тож усі дії з них — `STATE`.
 * Після підтвердження (`HANDED_OVER`) `amend/withdraw/decline` неможливі (Q12), а `return`/`mark_lost`/`recover`
 * працюють за чинними правилами.
 */
function resolveRecorded(
  from: LoanStatus,
  action: LoanAction,
  actor: LoanActor,
): LoanTransitionResult {
  switch (from) {
    case 'PENDING_CONFIRMATION':
      return fromPendingConfirmation(action, actor)
    case 'HANDED_OVER':
      return fromHandedOver(action, actor, 'RECORDED_EXISTING')
    case 'LOST':
      return fromLost(action, actor)
    case 'REQUESTED':
    case 'APPROVED':
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
    case 'DECLINED':
      return REFUSE('STATE')
  }
}

/** Примірник під записом: `RESERVED` і вдома (його ж поставив `POST /loans/recorded`). */
const RECORD_HELD: CopyPrecondition = { status: 'RESERVED', holder: 'OWNER' }

function fromPendingConfirmation(action: LoanAction, actor: LoanActor): LoanTransitionResult {
  switch (action) {
    case 'confirm_record':
      // Підтверджує отримання лише той, хто отримав (як `hand_over` у request-flow, §5.2).
      if (actor !== 'BORROWER') return REFUSE('ROLE')

      return {
        to: 'HANDED_OVER',
        requires: RECORD_HELD,
        copyStatus: 'LENT_OUT',
        holder: 'BORROWER',
        // `handedAt` — фактична дата, яку вказав власник; підтвердження її НЕ перезаписує.
        // `respondedAt` («власник відповів на запит») тут не має сенсу: запиту не було.
        stamp: null,
        notify: { to: 'OWNER', type: 'LOAN_RECORD_CONFIRMED' },
        // Лише тут (Q6/T3): книжка справді пішла, тож справжні конкуруючі `REQUESTED` відхиляються.
        rejectRivals: true,
        event: 'RECORD_CONFIRMED',
      }

    case 'decline_record':
      if (actor !== 'BORROWER') return REFUSE('ROLE')

      return {
        to: 'DECLINED',
        requires: RECORD_HELD,
        copyStatus: 'AVAILABLE',
        holder: null,
        stamp: null,
        notify: { to: 'OWNER', type: 'LOAN_RECORD_DECLINED' },
        // Чужі `REQUESTED` лишаються чинними: запис не відбувся.
        rejectRivals: false,
        event: 'RECORD_DECLINED',
      }

    case 'withdraw_record':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      return {
        to: 'CANCELLED',
        requires: RECORD_HELD,
        copyStatus: 'AVAILABLE',
        holder: null,
        stamp: null,
        notify: { to: 'BORROWER', type: 'LOAN_RECORD_WITHDRAWN' },
        rejectRivals: false,
        event: 'RECORD_WITHDRAWN',
      }

    case 'amend_record':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      // Статус і примірник не змінюються: правляться лише `handedAt`/`dueAt` (Q12, лише до відповіді).
      return {
        to: 'PENDING_CONFIRMATION',
        requires: RECORD_HELD,
        copyStatus: null,
        holder: null,
        stamp: null,
        notify: { to: 'BORROWER', type: 'LOAN_RECORD_AMENDED' },
        rejectRivals: false,
        event: 'RECORD_AMENDED',
      }

    case 'approve':
    case 'reject':
    case 'cancel':
    case 'hand_over':
    case 'return':
    case 'mark_lost':
    case 'recover':
      return REFUSE('STATE')
  }
}

function fromRequested(action: LoanAction, actor: LoanActor): LoanTransitionResult {
  switch (action) {
    case 'approve':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      return {
        to: 'APPROVED',
        // Апрув — єдина дія, що робить із вільної книжки зарезервовану, тож вона
        // й вимагає, щоб книжка справді була вільна та вдома.
        requires: { status: 'AVAILABLE', holder: 'OWNER' },
        copyStatus: 'RESERVED',
        // §5.2: підтвердження ≠ передача. Поки позичальник не натиснув «отримав»,
        // книжка формально вдома, тож тримач не змінюється.
        holder: null,
        stamp: 'respondedAt',
        notify: { to: 'BORROWER', type: 'LOAN_APPROVED' },
        rejectRivals: true,
        event: null,
      }

    case 'reject':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      return {
        to: 'REJECTED',
        // Передумов на примірник немає навмисно. Власник міг після появи запиту
        // перемкнути книжку в UNAVAILABLE («передумав давати») — і саме тоді
        // прибрати висячий запит потрібно найбільше. Вимога `AVAILABLE` зробила б
        // відмову неможливою рівно в тому випадку, заради якого вона існує.
        requires: null,
        // І не чіпає його: відмова на запит не має права мовчки «повернути»
        // примірник у AVAILABLE, скасувавши рішення власника.
        copyStatus: null,
        holder: null,
        stamp: 'respondedAt',
        notify: { to: 'BORROWER', type: 'LOAN_REJECTED' },
        rejectRivals: false,
        event: null,
      }

    case 'cancel':
      if (actor !== 'BORROWER') return REFUSE('ROLE')

      return {
        to: 'CANCELLED',
        // Те саме, що з `reject`: забрати власний запит можна завжди.
        requires: null,
        copyStatus: null,
        holder: null,
        // `respondedAt` — це «власник відповів». Позичальник, який забрав запит,
        // відповіді не отримав, тож поле лишається порожнім: інакше історія
        // стверджувала б, що відповідь була.
        stamp: null,
        // §5.1 сповіщення тут не передбачає, і §7.5 його не перелічує. «Він
        // передумав» — повідомлення, яке нікому не допомагає.
        notify: null,
        rejectRivals: false,
        event: null,
      }

    case 'hand_over':
    case 'return':
    case 'mark_lost':
    case 'recover':
    case 'confirm_record':
    case 'decline_record':
    case 'withdraw_record':
    case 'amend_record':
      return REFUSE('STATE')
  }
}

function fromApproved(action: LoanAction, actor: LoanActor): LoanTransitionResult {
  switch (action) {
    case 'cancel':
      // §5.1: єдиний рядок таблиці, доступний обом сторонам. Домовитися могли
      // двоє, тож і розмовитися має право кожен.
      return {
        to: 'CANCELLED',
        requires: { status: 'RESERVED', holder: 'OWNER' },
        copyStatus: 'AVAILABLE',
        holder: null,
        // `respondedAt` уже стоїть від апруву й НЕ перезаписується: він
        // відповідає на питання «коли власник відповів на запит», а не «коли
        // востаннє щось сталося».
        stamp: null,
        notify: { to: 'COUNTERPARTY', type: 'LOAN_CANCELLED' },
        rejectRivals: false,
        event: null,
      }

    case 'hand_over':
      if (actor !== 'BORROWER') return REFUSE('ROLE')

      // §5.2: підтверджує отримання саме той, хто отримав. Якби «передав» тиснув
      // власник, статус казав би про намір, а не про факт — і розсинхронізувався
      // б із реальністю в перший же тиждень.
      return {
        to: 'HANDED_OVER',
        requires: { status: 'RESERVED', holder: 'OWNER' },
        copyStatus: 'LENT_OUT',
        holder: 'BORROWER',
        stamp: 'handedAt',
        notify: { to: 'OWNER', type: 'LOAN_HANDED_OVER' },
        rejectRivals: false,
        event: null,
      }

    case 'approve':
    case 'reject':
    case 'return':
    case 'mark_lost':
    case 'recover':
    case 'confirm_record':
    case 'decline_record':
    case 'withdraw_record':
    case 'amend_record':
      return REFUSE('STATE')
  }
}

function fromHandedOver(
  action: LoanAction,
  actor: LoanActor,
  origin: LoanOrigin,
): LoanTransitionResult {
  switch (action) {
    case 'return':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      // Повернення підтверджує власник — він і бачить книжку на полиці. Якби це
      // робив позичальник, «я віддав» закривало б лоан без участі того, кому
      // віддали.
      return {
        to: 'RETURNED',
        requires: { status: 'LENT_OUT', holder: 'BORROWER' },
        copyStatus: 'AVAILABLE',
        holder: 'OWNER',
        stamp: 'returnedAt',
        notify: { to: 'BORROWER', type: 'LOAN_RETURNED' },
        rejectRivals: false,
        // Stage 10 (§6.8): записані власником позики мають audit trail і при поверненні; request-flow — ні.
        event: origin === 'REQUESTED' ? null : 'LOAN_RETURNED',
      }

    case 'mark_lost':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      return {
        to: 'LOST',
        requires: { status: 'LENT_OUT', holder: 'BORROWER' },
        copyStatus: 'UNAVAILABLE',
        // §5.1 прямо: «`currentHolderId` лишається на позичальнику». Книжка
        // фізично в нього — модель не має права вдавати, що вона повернулася.
        holder: null,
        // Окремої колонки під «коли списали» §4.6 не має, і вигадувати її без
        // вимоги специфікації не треба: стан термінальний.
        stamp: null,
        // §5.1 сповіщення для цього рядка не передбачає, і §7.5 його не перелічує.
        notify: null,
        rejectRivals: false,
        // Stage 10 (T4, §6.8): для нових позик момент втрати живе в `LoanEvent`, бо колонки
        // під нього немає. Старі `LOST`-позики цієї події не мають і не отримують.
        event: 'LOAN_LOST',
      }

    case 'approve':
    case 'reject':
    case 'cancel':
    case 'hand_over':
    case 'recover':
    case 'confirm_record':
    case 'decline_record':
    case 'withdraw_record':
    case 'amend_record':
      return REFUSE('STATE')
  }
}

/**
 * Stage 10 (T3, §6.6): `LOST → LOST` + подія `RECOVERED`. `Loan.status` НЕ змінюється, `stamp` немає:
 * минулі факти позики (`handedAt`, `returnedAt`, `responseNote`) не переписуються. Змінюється лише
 * примірник — він знову вдома й доступний. Однократність (одна подія на позику) перевіряє сервіс і
 * тримає частковий унікальний індекс; тут лише «хто» і «який стан примірника».
 */
function fromLost(action: LoanAction, actor: LoanActor): LoanTransitionResult {
  switch (action) {
    case 'recover':
      if (actor !== 'OWNER') return REFUSE('ROLE')

      return {
        to: 'LOST',
        // `mark_lost` лишає тримачем позичальника (§5.1): відновлюється рівно цей стан.
        requires: { status: 'UNAVAILABLE', holder: 'BORROWER' },
        copyStatus: 'AVAILABLE',
        holder: 'OWNER',
        stamp: null,
        notify: null,
        rejectRivals: false,
        event: 'RECOVERED',
      }

    case 'approve':
    case 'reject':
    case 'cancel':
    case 'hand_over':
    case 'return':
    case 'mark_lost':
    case 'confirm_record':
    case 'decline_record':
    case 'withdraw_record':
    case 'amend_record':
      return REFUSE('STATE')
  }
}

// ---------------------------------------------------------------------------
// Stage 10 (10f.3): гостьова позика — окрема, вужча таблиця переходів.
// ---------------------------------------------------------------------------

/**
 * Гостьова позика ніколи не буває `REQUESTED`/`APPROVED`/`PENDING_CONFIRMATION`/`DECLINED`:
 * `POST /loans/guest` створює її одразу `HANDED_OVER` (§6.2 execution plan, «— → HANDED_OVER»).
 */
export type GuestLoanStatus = Extract<LoanStatus, 'HANDED_OVER' | 'RETURNED' | 'LOST'>

/**
 * Навмисно окрема, менша структура від `LoanTransition`: у гостьової позики рівно один актор
 * (власник — гість без акаунта нічого не підтверджує), тож немає ні `requires.holder`
 * (порівняння з `Copy.heldByContactId` — структурний інваріант, не альтернатива стану, і його
 * перевіряє виклик, а не ця чиста функція), ні `notify` (сповіщати нікого, крім самого власника,
 * нема), ні `rejectRivals` (конкурентні `REQUESTED` відхиляються один раз, атомарно, у момент
 * `POST /loans/guest` — а не в жодному з цих переходів).
 */
export interface GuestLoanTransition {
  to: GuestLoanStatus
  /** Стан `Copy`, який мусить бути правдою до переходу; `null` — `close_loss` `Copy` не перевіряє (T7b-4). */
  requiresCopyStatus: CopyStatus | null
  /** `null` — `Copy.status` не чіпається (`close_loss`). */
  copyStatus: CopyStatus | null
  /** `'OWNER'` — книжка повертається власнику; `null` — тримач не змінюється. Гостя як holder-output не буває: `heldByContactId` завжди йде в `NULL` разом із поверненням власнику, ніколи не «до іншого контакту». */
  copyHolder: 'OWNER' | null
  stamp: 'returnedAt' | null
  event: Extract<LoanEventType, 'LOAN_RETURNED' | 'LOAN_LOST' | 'RECOVERED' | 'LOSS_CLOSED'>
}

export type GuestLoanTransitionResult = GuestLoanTransition | { kind: 'refused' }

/**
 * §6.2 execution plan (таблиця переходів гостьової позики) буквально, плюс T7b (`close_loss`).
 *
 * `close_loss` навмисно **не** змінює жодного поля `Copy`/`Loan.status` (§0.7.1: дія стосується
 * лише питання «чи вважати втрату вирішеною для D3», не фізичного стану книжки) — саме тому
 * `requiresCopyStatus`, `copyStatus` і `copyHolder` тут `null`.
 */
export function resolveGuestTransition(
  from: GuestLoanStatus,
  action: GuestLoanAction,
): GuestLoanTransitionResult {
  switch (from) {
    case 'HANDED_OVER':
      switch (action) {
        case 'return':
          return {
            to: 'RETURNED',
            requiresCopyStatus: 'LENT_OUT',
            copyStatus: 'AVAILABLE',
            copyHolder: 'OWNER',
            stamp: 'returnedAt',
            event: 'LOAN_RETURNED',
          }
        case 'mark_lost':
          return {
            to: 'LOST',
            requiresCopyStatus: 'LENT_OUT',
            copyStatus: 'UNAVAILABLE',
            // §6.2: «currentHolderId лишається на позичальнику» — для гостя це `heldByContactId`,
            // який теж не чіпається (той самий принцип, що для reєстрованого `mark_lost`).
            copyHolder: null,
            stamp: null,
            event: 'LOAN_LOST',
          }
        case 'recover':
        case 'close_loss':
          return { kind: 'refused' }
      }
      break
    case 'LOST':
      switch (action) {
        case 'recover':
          return {
            to: 'LOST',
            requiresCopyStatus: 'UNAVAILABLE',
            copyStatus: 'AVAILABLE',
            copyHolder: 'OWNER',
            stamp: null,
            event: 'RECOVERED',
          }
        case 'close_loss':
          return {
            to: 'LOST',
            requiresCopyStatus: null,
            copyStatus: null,
            copyHolder: null,
            stamp: null,
            event: 'LOSS_CLOSED',
          }
        case 'return':
        case 'mark_lost':
          return { kind: 'refused' }
      }
      break
    case 'RETURNED':
      return { kind: 'refused' }
  }

  return { kind: 'refused' }
}

// ---------------------------------------------------------------------------
// Stage 10 (10f.3, рев'ю): єдина точка входу диспетчера переходів.
// ---------------------------------------------------------------------------

/**
 * До цього виправлення `LoanService.runTransition` викликав `resolveTransition`, а
 * `GuestLoanService.applyTransition` — `resolveGuestTransition`, кожен окремо. Те, що обидві
 * функції жили в одному файлі, не робило їх «спільним диспетчером» — рішення «яку з двох таблиць
 * запитати» було розкидане по двох різних сервісах. `resolveLoanTransition` — типізована
 * тегована сполука (`kind: 'REGISTERED' | 'GUEST'`), крізь яку **обидва** сервіси тепер
 * зобов'язані пройти: внутрішні таблиці (`resolveTransition`/`resolveGuestTransition`) лишаються
 * окремими — гостьова позика не має ні протилежної сторони, ні `LoanActor`/`LoanOrigin`, і
 * силувати їх в один тип означало б додавати реєстрованій таблиці поля, які їй не потрібні.
 * Транзакційні сервіси (лок, запис, сповіщення) **не** об'єднані — вони лишаються двома різними
 * реалізаціями з різною формою рядка `Loan`, як і раніше.
 */
export interface RegisteredTransitionRequest {
  kind: 'REGISTERED'
  from: LoanStatus
  action: LoanAction
  actor: LoanActor
  origin: LoanOrigin
}

export interface GuestTransitionRequest {
  kind: 'GUEST'
  from: GuestLoanStatus
  action: GuestLoanAction
}

export type LoanTransitionRequest = RegisteredTransitionRequest | GuestTransitionRequest

export interface RegisteredTransitionDecision {
  kind: 'REGISTERED'
  result: LoanTransitionResult
}

export interface GuestTransitionDecision {
  kind: 'GUEST'
  result: GuestLoanTransitionResult
}

export type LoanTransitionDecision = RegisteredTransitionDecision | GuestTransitionDecision

/**
 * Єдина функція, крізь яку проходить рішення «чи можна» — і для реєстрованої, і для гостьової
 * позики. Перевантаження (не одна загальна сигнатура) — щоб виклик із буквальним `kind:
 * 'REGISTERED'`/`kind: 'GUEST'` повертав звужений тип одразу, без ручного звуження на кожному
 * виклику в `LoanService`/`GuestLoanService`.
 */
export function resolveLoanTransition(
  request: RegisteredTransitionRequest,
): RegisteredTransitionDecision
export function resolveLoanTransition(request: GuestTransitionRequest): GuestTransitionDecision
export function resolveLoanTransition(request: LoanTransitionRequest): LoanTransitionDecision {
  if (request.kind === 'GUEST') {
    return { kind: 'GUEST', result: resolveGuestTransition(request.from, request.action) }
  }

  return {
    kind: 'REGISTERED',
    result: resolveTransition(request.from, request.action, request.actor, request.origin),
  }
}
