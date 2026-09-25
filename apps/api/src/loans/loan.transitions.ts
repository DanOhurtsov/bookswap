import type { CopyStatus, LoanAction, LoanStatus, NotificationType } from '@bookswap/shared'

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
): LoanTransitionResult {
  switch (from) {
    case 'REQUESTED':
      return fromRequested(action, actor)
    case 'APPROVED':
      return fromApproved(action, actor)
    case 'HANDED_OVER':
      return fromHandedOver(action, actor)
    // Чотири термінальні стани §5.1. З них не веде жоден перехід — ні для кого.
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
    case 'LOST':
      return REFUSE('STATE')
    // Stage 10 (T3): статуси існують у схемі з кроку 10a, але переходи з них додасть
    // крок 10e. Доти жоден рядок так не позначений, а request-flow дії з них неможливі.
    case 'PENDING_CONFIRMATION':
    case 'DECLINED':
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
      }

    case 'hand_over':
    case 'return':
    case 'mark_lost':
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
      }

    case 'approve':
    case 'reject':
    case 'return':
    case 'mark_lost':
      return REFUSE('STATE')
  }
}

function fromHandedOver(action: LoanAction, actor: LoanActor): LoanTransitionResult {
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
      }

    case 'approve':
    case 'reject':
    case 'cancel':
    case 'hand_over':
      return REFUSE('STATE')
  }
}
