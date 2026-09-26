import type {
  AuthorRole,
  Channel,
  Condition,
  CopyStatus,
  EditionFormat,
  LoanAction,
  LoanStatus,
  NotificationType,
  Visibility,
} from '@bookswap/shared'

/**
 * Людські підписи до доменних enum'ів.
 *
 * Живуть у `apps/web`, а не в `packages/shared`: контракт описує **значення**, а
 * як їх називати людині — справа інтерфейсу. §15.5 лишає питання мови UI
 * відкритим, і тримати переклади в спільному пакеті означало б відповісти на
 * нього за всіх.
 */

export const VISIBILITY_LABELS: Readonly<Record<Visibility, string>> = {
  PUBLIC: 'Публічно — бачить будь-хто',
  FRIENDS: 'Для друзів',
  PRIVATE: 'Приватно — тільки я',
}

export const CONDITION_LABELS: Readonly<Record<Condition, string>> = {
  NEW: 'Як нова',
  GOOD: 'Добрий стан',
  WORN: 'Потерта',
  DAMAGED: 'Пошкоджена',
}

export const COPY_STATUS_LABELS: Readonly<Record<CopyStatus, string>> = {
  AVAILABLE: 'Вдома, вільна',
  RESERVED: 'Домовлено про передачу',
  LENT_OUT: 'У позичальника',
  UNAVAILABLE: 'Тимчасово не даю',
}

/**
 * §5.1 у словах користувача.
 *
 * `RESERVED`/`APPROVED` навмисно звучать як «домовлено», а не «підтверджено»:
 * §5.2 наполягає, що підтвердження — ще не передача, і підпис має говорити те
 * саме, інакше людина вважатиме, що книжка вже її.
 */
export const LOAN_STATUS_LABELS: Readonly<Record<LoanStatus, string>> = {
  REQUESTED: 'Чекає на відповідь',
  APPROVED: 'Домовлено, ще не передано',
  REJECTED: 'Відмовлено',
  CANCELLED: 'Скасовано',
  HANDED_OVER: 'На руках',
  RETURNED: 'Повернено',
  LOST: 'Втрачено',
  // Stage 10 (10e): запис власника, що чекає відповіді позичальника.
  PENDING_CONFIRMATION: 'Очікує підтвердження',
  DECLINED: 'Відхилено позичальником',
}

/** Підписи кнопок §8. Дієслово від першої особи того, хто тисне. */
export const LOAN_ACTION_LABELS: Readonly<Record<LoanAction, string>> = {
  approve: 'Погодити',
  reject: 'Відмовити',
  cancel: 'Скасувати',
  hand_over: 'Я отримав книжку',
  return: 'Книжку повернуто',
  mark_lost: 'Позначити втраченою',
  recover: 'Знайшлася',
  confirm_record: 'Підтверджую: отримав книжку',
  decline_record: 'Відхилити запис',
  withdraw_record: 'Відкликати запис',
  amend_record: 'Зберегти нові дати',
}

export const NOTIFICATION_TYPE_LABELS: Readonly<Record<NotificationType, string>> = {
  LOAN_REQUESTED: 'У вас просять книжку',
  LOAN_APPROVED: 'Ваше прохання погодили',
  LOAN_REJECTED: 'Книжку не дали',
  LOAN_CANCELLED: 'Домовленість скасовано',
  LOAN_HANDED_OVER: 'Книжку передано',
  LOAN_RETURNED: 'Книжку повернуто',
  LOAN_DUE_SOON: 'Скоро повертати',
  LOAN_OVERDUE: 'Термін минув',
  FRIEND_REQUESTED: 'Новий запит у друзі',
  FRIEND_ACCEPTED: 'Запит у друзі прийнято',
  LOAN_RECORD_PROPOSED: 'Вам записали передачу книжки',
  LOAN_RECORD_AMENDED: 'Запис про передачу виправлено',
  LOAN_RECORD_CONFIRMED: 'Отримання підтверджено',
  LOAN_RECORD_DECLINED: 'Запис про передачу відхилено',
  LOAN_RECORD_WITHDRAWN: 'Запис про передачу відкликано',
}

/**
 * §4.8 — канали доставки. `IN_APP` — повноправна колонка матриці §7.6, з
 * власним перемикачем (`channelStates()` позначає її `editable: true`), а не
 * лише підпис у поясненнях: людина може вимкнути список на сайті окремо від
 * email і Telegram.
 */
export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = {
  IN_APP: 'У застосунку',
  EMAIL: 'Пошта',
  TELEGRAM: 'Telegram',
}

export const EDITION_FORMAT_LABELS: Readonly<Record<EditionFormat, string>> = {
  HARDCOVER: 'тверда',
  PAPERBACK: 'мʼяка',
  POCKET: 'кишенькова',
}

export const AUTHOR_ROLE_LABELS: Readonly<Record<AuthorRole, string>> = {
  AUTHOR: 'автор',
  CO_AUTHOR: 'співавтор',
  EDITOR: 'редактор',
  ILLUSTRATOR: 'ілюстратор',
}

/**
 * Підказки для поля мови — не заміна валідації.
 *
 * Це `datalist`, а не `select`: ISO 639-1 має 184 коди, і випадаючий список із
 * них нечитабельний, а обрізаний до десятка зробив би книжку баскською мовою
 * недодаваною. Тут — те, що трапляється на домашній полиці; ввести можна
 * будь-який валідний код, і перевірить його спільна схема.
 */
export const LANGUAGE_HINTS: readonly { code: string; label: string }[] = [
  { code: 'uk', label: 'українська' },
  { code: 'en', label: 'англійська' },
  { code: 'pl', label: 'польська' },
  { code: 'de', label: 'німецька' },
  { code: 'fr', label: 'французька' },
  { code: 'es', label: 'іспанська' },
  { code: 'it', label: 'італійська' },
  { code: 'cs', label: 'чеська' },
  { code: 'ja', label: 'японська' },
  { code: 'la', label: 'латина' },
]

/** ISO-дата з API → коротка людська дата. Локаль явна: сервер і клієнт мусять збігтися. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
