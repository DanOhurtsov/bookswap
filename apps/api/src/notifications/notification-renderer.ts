import { isDigestNotificationType, isGuestResponseNotificationType } from '@bookswap/shared'
import type { Channel, NotificationPayload, NotificationType } from '@bookswap/shared'
import type { DeliveryAction, RenderedNotification } from './channels/notification-channel'

/**
 * Перетворення події на текст (§7.3).
 *
 * Чиста функція без доступу до бази: усе, що вона знає про світ, приїжджає
 * аргументом. Це те, що дозволяє перевірити формулювання й — головне — набір
 * інлайн-кнопок, не піднімаючи ні PostgreSQL, ні Telegram.
 *
 * Один текст на всі канали — крім відповідей гостя (10i.3): їх рішення PO вимагає
 * показувати в застосунку змістовно, а в листі — лише загальним нагадуванням, бо
 * пошта покидає контур BookSwap. Різниця живе тут, у чистій функції, а не в каналі:
 * канал не знає про типи подій (§7.3).
 */
export interface NotificationView {
  type: NotificationType
  payload: NotificationPayload
  /** Ім'я того, хто зробив дію (`payload.actorId`), якщо його вдалося прочитати. */
  actorName: string | null
  /** Назва твору за `payload.copyId`. */
  bookTitle: string | null
  /** §6.1: посилання ведуть на фронт, не на API — там сесія користувача. */
  webOrigin: string
}

/** §7.4: «кнопки з `callback_data` виду `loan:approve:<loanId>`». */
export const LOAN_CALLBACK_PREFIX = 'loan'

function someone(actorName: string | null): string {
  return actorName ?? 'Хтось із друзів'
}

function book(bookTitle: string | null): string {
  return bookTitle === null ? 'книжку' : `«${bookTitle}»`
}

/**
 * Скільки книжок у щоденному дайджесті (§7.5).
 *
 * Дайджест агрегує події на людину за добу, тож `payload.count` більший за одиницю
 * — звичайний випадок, а не крайній. Текст мусить це відображати: «Термін
 * повернення «Шантарам» минув», коли прострочених насправді п'ять, — гірше за
 * мовчання, бо людина поверне одну й вважатиме питання закритим.
 */
function digestCount(payload: NotificationPayload): number {
  const parsed = Number(payload.count ?? '1')

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1
}

/** «книжку» / «2 книжки» / «5 книжок» — українська форма множини. */
function books(count: number): string {
  const tail = count % 100
  const last = count % 10

  if (tail >= 11 && tail <= 14) return `${String(count)} книжок`
  if (last === 1) return `${String(count)} книжку`
  if (last >= 2 && last <= 4) return `${String(count)} книжки`

  return `${String(count)} книжок`
}

/** Назва однієї книжки або «N книжок» — залежно від того, скільки їх у дайджесті. */
function digestSubject(view: NotificationView): string {
  const count = digestCount(view.payload)

  return count === 1 ? book(view.bookTitle) : books(count)
}

function loanLink(view: NotificationView): string | null {
  // Stage 10 (10i.3): відповідь гостя веде на екран гостьових позик власника (запит, а не зареєстрована позика).
  if (isGuestResponseNotificationType(view.type)) {
    const confirmationId = view.payload.confirmationId

    return confirmationId === undefined
      ? `${view.webOrigin}/loans/guest`
      : `${view.webOrigin}/loans/guest?confirmationId=${encodeURIComponent(confirmationId)}`
  }

  const loanId = view.payload.loanId

  return loanId === undefined
    ? null
    : `${view.webOrigin}/loans?loanId=${encodeURIComponent(loanId)}`
}

/**
 * Кнопки — лише там, де дія осмислена й безпечна.
 *
 * Рівно один випадок: власник отримав запит і може відповісти, не відкриваючи
 * сайт. Саме заради нього §7.2 називає Telegram каналом, який «стане основним на
 * практиці». Решта подій або нічого не потребують, або потребують контексту, який
 * у кнопку не вміщається.
 *
 * Кнопок немає навіть тоді, коли `loanId` є, а тип інший: `callback_data` приходить
 * від клієнта (§7.4), і кожна зайва кнопка — це ще один рядок, який обробник
 * зобов'язаний авторизувати.
 */
function actionsFor(view: NotificationView): DeliveryAction[] {
  const loanId = view.payload.loanId

  if (view.type !== 'LOAN_REQUESTED' || loanId === undefined) return []

  return [
    { label: '✅ Погодити', data: `${LOAN_CALLBACK_PREFIX}:approve:${loanId}` },
    { label: '✖️ Відмовити', data: `${LOAN_CALLBACK_PREFIX}:reject:${loanId}` },
  ]
}

/**
 * Тема й перший рядок тіла. Друге — те саме речення, тож пишеться один раз.
 *
 * Формулювання навмисно безособові там, де в реченні мав би стояти дієприкметник
 * минулого часу («погодився», «прийняв»): рід користувача сервіс не знає й не
 * питає, а вгадувати його за іменем — гарантовано помилятися на частині людей.
 * Пасивний стан («запит погоджено») цієї проблеми не має.
 */
function headline(view: NotificationView): string {
  const who = someone(view.actorName)
  const what = book(view.bookTitle)

  switch (view.type) {
    case 'LOAN_REQUESTED':
      return `${who} просить ${what}`
    case 'LOAN_APPROVED':
      return `Запит на ${what} погоджено`
    case 'LOAN_REJECTED':
      return `Запит на ${what} відхилено`
    case 'LOAN_CANCELLED':
      return `Домовленість про ${what} скасовано`
    case 'LOAN_HANDED_OVER':
      return `${what} передано позичальнику`
    case 'LOAN_RETURNED':
      return `${what} повернено власнику`
    // §7.5: дайджест. `what` тут — не одна книжка, а стільки, скільки їх зібралося
    // за добу; текст на одну книжку зробив би решту невидимими.
    case 'LOAN_DUE_SOON':
      return `Скоро повертати ${digestSubject(view)}`
    case 'LOAN_OVERDUE':
      return `Час повертати ${digestSubject(view)}: термін минув`
    case 'FRIEND_REQUESTED':
      return `${who} хоче додати вас у друзі`
    case 'FRIEND_ACCEPTED':
      return `Запит у друзі прийнято: ${who}`
    // Stage 10 (10e): формулювання безособові й не стверджують непідтверджений факт — це запис власника,
    // а не погоджена передача, доки позичальник не відповів.
    case 'LOAN_RECORD_PROPOSED':
      return `Записано передачу ${what}: ${who} вказує, що книжка вже у вас`
    case 'LOAN_RECORD_AMENDED':
      return `Виправлено запис про передачу ${what}`
    case 'LOAN_RECORD_CONFIRMED':
      return `Отримання ${what} підтверджено`
    case 'LOAN_RECORD_DECLINED':
      return `Запис про передачу ${what} відхилено`
    case 'LOAN_RECORD_WITHDRAWN':
      return `Запис про передачу ${what} відкликано`
    // Stage 10 (10i.3): без нікнейма й email гостя — лише факт відповіді через посилання. Це відповідь після
    // підтвердження контролю введеного гостем email, а не доведена особа (§0.12 п. 4).
    case 'GUEST_LOAN_RECEIVED':
      return `Гість підтвердив отримання ${what}`
    case 'GUEST_LOAN_DENIED':
      return `Гість заперечує отримання ${what}`
  }
}

/** Що людині робити далі. Порожній рядок означає «нічого, це до відома». */
function callToAction(view: NotificationView): string {
  switch (view.type) {
    case 'LOAN_REQUESTED':
      return 'Погодьте або відхиліть запит.'
    case 'LOAN_APPROVED':
      return 'Домовтеся про передачу — книжка чекає на полиці власника.'
    case 'LOAN_HANDED_OVER':
      return 'Книжка тепер у позичальника.'
    case 'LOAN_DUE_SOON':
      return 'Не забудьте повернути вчасно.'
    case 'LOAN_OVERDUE':
      return 'Поверніть книжку або домовтеся про новий термін.'
    case 'FRIEND_REQUESTED':
      return 'Прийміть або відхиліть запит у друзі.'
    case 'LOAN_RECORD_PROPOSED':
      return 'Підтвердьте, що отримали книжку, або відхиліть запис. Доки ви не відповіли, книжка недоступна іншим.'
    case 'LOAN_RECORD_AMENDED':
      return 'Перегляньте нові дати й підтвердьте отримання або відхиліть запис.'
    case 'LOAN_RECORD_DECLINED':
      return 'Книжка знову вільна.'
    case 'LOAN_RECORD_CONFIRMED':
      return 'Книжка тепер у позичальника.'
    case 'GUEST_LOAN_RECEIVED':
      return 'Книжка тепер позначена як передана гостю з підтвердженням гостя.'
    case 'GUEST_LOAN_DENIED':
      return 'Це розбіжність, а не повернення: примірник лишається недоступним, доки ви не вирішите, що з нею робити.'
    case 'LOAN_RECORD_WITHDRAWN':
    case 'LOAN_REJECTED':
    case 'LOAN_CANCELLED':
    case 'LOAN_RETURNED':
    case 'FRIEND_ACCEPTED':
      return ''
  }
}

function link(view: NotificationView): string {
  if (view.type === 'FRIEND_REQUESTED' || view.type === 'FRIEND_ACCEPTED') {
    return `${view.webOrigin}/friends`
  }

  // Дайджест на кілька книжок веде до списку, а не до першої з них: посилання на
  // один лоан із п'яти виглядало б як «ось воно» і сховало б решту.
  if (isDigestNotificationType(view.type) && digestCount(view.payload) > 1) {
    return `${view.webOrigin}/loans?role=borrower`
  }

  return loanLink(view) ?? `${view.webOrigin}/notifications`
}

/** Загальні тема й посилання листа про відповідь гостя: без книжки, результату, гостя чи id запиту. */
export const GENERIC_EMAIL_SUBJECT = 'У вас нове повідомлення в BookSwap'

function renderGenericEmail(webOrigin: string): RenderedNotification {
  return {
    subject: GENERIC_EMAIL_SUBJECT,
    body: [
      GENERIC_EMAIL_SUBJECT,
      `Щоб його прочитати, увійдіть у BookSwap: ${webOrigin}/login`,
    ].join('\n\n'),
    actions: [],
  }
}

/**
 * `channel` важливий лише для відповідей гостя. Для них: IN_APP — змістовний текст, EMAIL — строго
 * загальний, TELEGRAM — не існує (рядок такої доставки не створюється; спроба відрендерити — помилка).
 */
export function renderNotification(
  view: NotificationView,
  channel: Channel = 'IN_APP',
): RenderedNotification {
  if (isGuestResponseNotificationType(view.type)) {
    if (channel === 'EMAIL') return renderGenericEmail(view.webOrigin)
    if (channel === 'TELEGRAM') {
      throw new Error(`Тип ${view.type} не надсилається в Telegram`)
    }
  }

  const subject = headline(view)
  const lines = [subject, callToAction(view), link(view)].filter((line) => line !== '')

  return {
    subject: `BookSwap: ${subject}`,
    body: lines.join('\n\n'),
    actions: actionsFor(view),
  }
}
