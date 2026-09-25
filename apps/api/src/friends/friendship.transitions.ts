import type { FriendshipStatus } from '@bookswap/shared'
import type { ActorRole, FriendshipState } from '../access/friendship.pair'

/**
 * Стейт-машина дружби. Чиста: ні Prisma, ні Nest, ні винятків HTTP.
 *
 * Це та сама вимога, яку §5 ставить лоанам, застосована до §6.2: усі переходи —
 * через одну точку. Тут вона доведена до кінця — рішення «можна чи ні» взагалі не
 * має доступу до бази, тож обійти його з контролера технічно неможливо, а повна
 * матриця переходів покривається unit-тестом без PostgreSQL.
 *
 * `FriendsService` перекладає результат у запис і в `ApiException`; більше ніхто
 * не має права дивитися на `Friendship.status`.
 */

export type FriendshipAction = 'request' | 'accept' | 'decline' | 'remove' | 'block' | 'invite'

export type TransitionOutcome =
  /** Рядка немає — створити з цим статусом. */
  | { kind: 'create'; status: Extract<FriendshipStatus, 'PENDING' | 'BLOCKED' | 'ACCEPTED'> }
  /** Рядок є — перевести в цей статус. */
  | { kind: 'update'; to: FriendshipStatus }
  /** Рядок є — видалити. Видалення дружби НЕ чіпає активні `Loan` (§5.2). */
  | { kind: 'delete' }
  /** Пара вже в потрібному стані: ідемпотентний успіх без запису. */
  | { kind: 'unchanged' }

export type RefusalReason =
  /** Пара заблокована, або знімати блок намагається не той, хто його поставив. */
  | 'BLOCKED'
  /** Звʼязок уже є: друзі або запит висить. */
  | 'EXISTS'
  /** Дія сама по собі можлива, але не для цієї ролі. */
  | 'ROLE'
  /** Дія неможлива в цьому стані. */
  | 'STATE'

export type TransitionResult = TransitionOutcome | { kind: 'refused'; reason: RefusalReason }

const REFUSE = (reason: RefusalReason): TransitionResult => ({ kind: 'refused', reason })

/**
 * Єдине місце, де записано, що з чого можна.
 *
 * Порядок перевірок значущий: `BLOCKED` відсікається першим, бо §6.2 робить його
 * сильнішим за будь-який інший стан — заблокований не може ні надіслати запит, ні
 * прийняти давній.
 */
export function resolveTransition(
  state: FriendshipState,
  action: FriendshipAction,
  actor: ActorRole,
): TransitionResult {
  if (state === 'BLOCKED') return fromBlocked(action, actor)

  switch (action) {
    case 'request':
      return toRequest(state, actor)
    case 'accept':
      return toAccept(state, actor)
    case 'decline':
      return toDecline(state, actor)
    case 'remove':
      return toRemove(state)
    case 'invite':
      return toInvite(state)
    case 'block':
      // §6.2: заблокувати можна з будь-якого стану, включно з «незнайомі».
      return state === 'NONE'
        ? { kind: 'create', status: 'BLOCKED' }
        : { kind: 'update', to: 'BLOCKED' }
  }
}

function fromBlocked(action: FriendshipAction, actor: ActorRole): TransitionResult {
  // Розблокування — це видалення рядка (§8 окремого маршруту не має), і зняти
  // блок може лише той, хто його поставив. Інакше заблокований знімав би його сам,
  // і блокування не означало б нічого.
  if (action === 'remove' && actor === 'BLOCKER') return { kind: 'delete' }

  return REFUSE('BLOCKED')
}

function toRequest(state: FriendshipState, actor: ActorRole): TransitionResult {
  switch (state) {
    case 'NONE':
      return { kind: 'create', status: 'PENDING' }
    // Відхилений запит не закриває пару назавжди: одне випадкове «Відхилити»
    // інакше стало б вироком, а §6.2 не дає способу його скасувати. Від
    // настирливості захищає rate limiting (§11) і `block`, а не вічний DECLINED.
    case 'DECLINED':
      return { kind: 'update', to: 'PENDING' }
    case 'PENDING':
      // Взаємний запит — це згода: обидві сторони висловили той самий намір, і
      // змушувати другого шукати вхідний запит немає сенсу. Заразом саме це
      // робить справді паралельний випадок збіжним — той, хто програв гонку на
      // INSERT, перечитує рядок і опиняється тут.
      return actor === 'RECIPIENT' ? { kind: 'update', to: 'ACCEPTED' } : REFUSE('EXISTS')
    case 'ACCEPTED':
      return REFUSE('EXISTS')
    case 'BLOCKED':
      return REFUSE('BLOCKED')
  }
}

function toAccept(state: FriendshipState, actor: ActorRole): TransitionResult {
  if (state !== 'PENDING') return REFUSE('STATE')

  // Прийняти власний запит не можна — інакше дружба заводиться в односторонньому порядку.
  return actor === 'RECIPIENT' ? { kind: 'update', to: 'ACCEPTED' } : REFUSE('ROLE')
}

function toDecline(state: FriendshipState, actor: ActorRole): TransitionResult {
  if (state !== 'PENDING') return REFUSE('STATE')

  // Відкликати власний запит — це `remove`, а не `decline`: сліду DECLINED після
  // скасування власного запиту бути не повинно.
  return actor === 'RECIPIENT' ? { kind: 'update', to: 'DECLINED' } : REFUSE('ROLE')
}

/**
 * Етап 9: прийняття запрошення. Запрошувач погодився, створивши запрошення, а
 * запрошений щойно явно натиснув «Прийняти» — тож обидві згоди є, і дружба
 * одразу `ACCEPTED`. Роль не важлива: висячий запит у будь-який бік теж стає
 * дружбою, бо намір обох сторін той самий.
 */
function toInvite(state: FriendshipState): TransitionResult {
  switch (state) {
    case 'NONE':
      return { kind: 'create', status: 'ACCEPTED' }
    case 'PENDING':
    case 'DECLINED':
      return { kind: 'update', to: 'ACCEPTED' }
    case 'ACCEPTED':
      return { kind: 'unchanged' }
    case 'BLOCKED':
      return REFUSE('BLOCKED')
  }
}

function toRemove(state: FriendshipState): TransitionResult {
  // Прибрати можна будь-який наявний звʼязок, і з будь-якого боку: скасувати свій
  // запит, прибрати чужий, розійтися. Активні `Loan` при цьому не чіпаються (§5.2) —
  // фізична книжка все одно в когось.
  return state === 'NONE' ? REFUSE('STATE') : { kind: 'delete' }
}
