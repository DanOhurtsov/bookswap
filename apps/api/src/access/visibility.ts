import type { Visibility } from '@bookswap/shared'

/**
 * §9, матриця доступу — буквально таблицею, у чистих функціях.
 *
 * Нічого з цього не ходить у базу. Розділення навмисне: рішення «чи видно» — це
 * порівняння двох enum'ів і однієї ролі, а не запит. Тримаючи його чистим, ми
 * отримуємо повне покриття матриці unit-тестом без PostgreSQL, і — головне —
 * одну реалізацію правил замість «майже однакових» умов у кожному контролері.
 *
 * Звідки береться роль — справа `AccessService.roleOf()`, який єдиний ходить у
 * `Friendship`.
 */
export type ViewerRole =
  /** Власник ресурсу. */
  | 'OWNER'
  /** Дружба в статусі `ACCEPTED`. */
  | 'FRIEND'
  /**
   * BS-148: not a friend, but has a mutual `ACCEPTED` friend with an owner who opened the library to
   * friends of friends (`User.friendsOfFriendsAccess`). Sees the library and borrows like a friend;
   * never the history with names and never the full profile.
   */
  | 'FRIEND_OF_FRIEND'
  /** Будь-хто інший: незнайомець, той, чий запит висить, той, кому відмовили. */
  | 'OTHER'
  /**
   * Пара заблокована — у будь-якому напрямку.
   *
   * Окрема роль, а не `OTHER`, і це не формальність: §6.2 каже «заблокований не
   * бачить бібліотеку», без застережень про `Visibility`. Якби блокування зводилося
   * до `OTHER`, публічна бібліотека лишалася б видимою заблокованому — тобто
   * блокування мовчки не працювало б саме для тих, хто відкрився світу.
   */
  | 'BLOCKED'

/**
 * Шкала суворості: PRIVATE > FRIENDS > PUBLIC.
 *
 * Числа, а не порядок у масиві: `VISIBILITY` зі `shared` перелічує значення в
 * порядку «від відкритого», і покладатися на індекс у ньому означало б зламати
 * видимість, переставивши рядки в іншому пакеті.
 */
const STRICTNESS: Readonly<Record<Visibility, number>> = {
  PUBLIC: 0,
  FRIENDS: 1,
  PRIVATE: 2,
}

/** §9: «видимість примірника = найсуворіше з видимості бібліотеки та примірника». */
export function strictestVisibility(one: Visibility, other: Visibility): Visibility {
  return STRICTNESS[one] >= STRICTNESS[other] ? one : other
}

/**
 * §9, рядки «Бібліотека PUBLIC / FRIENDS / PRIVATE».
 *
 * Власник бачить своє завжди — навіть `PRIVATE`. Інакше налаштування приватності
 * ховало б бібліотеку від самого власника.
 *
 * Заблокований не бачить нічого — §6.2 не робить винятку для `PUBLIC`. Перевірка
 * стоїть ПЕРШОЮ: блокування сильніше за будь-яку видимість, і порядок тут — це
 * саме те правило, а не оптимізація.
 */
export function isVisibleTo(role: ViewerRole, visibility: Visibility): boolean {
  if (role === 'BLOCKED') return false
  if (role === 'OWNER') return true
  if (role === 'FRIEND' || role === 'FRIEND_OF_FRIEND') return visibility !== 'PRIVATE'

  return visibility === 'PUBLIC'
}

/**
 * §9, рядок «Створити запит на позичання»: друг — так, і (BS-148) друг друга. Одна функція для
 * `LoanService.request()` і його передбачення `canRequestCopy`, щоб вони не розійшлися.
 */
export function mayRequestLoan(role: ViewerRole): boolean {
  return role === 'FRIEND' || role === 'FRIEND_OF_FRIEND'
}

/**
 * §9, рядок «Примірник із власною visibility».
 *
 * `Copy.visibility` не заміняє видимість бібліотеки, а додається до неї: `PUBLIC`
 * примірник у `PRIVATE` бібліотеці лишається невидимим. Інакше одне поле на
 * примірнику мовчки скасовувало б налаштування профілю.
 */
export function copyVisibleTo(
  role: ViewerRole,
  libraryVisibility: Visibility,
  copyVisibility: Visibility,
): boolean {
  return isVisibleTo(role, strictestVisibility(libraryVisibility, copyVisibility))
}

/**
 * §6.6: повну історію з іменами власник бачить завжди; друг — за `showHolderNames`;
 * стороннього немає в таблиці взагалі, тож для нього завжди `false`.
 *
 * Прапорець власника не питається у стороннього не тому, що він `false`, а тому
 * що §9 не дає стороннім доступу до історії в принципі — навіть із `showHolderNames`.
 * A friend of a friend (BS-148) is the same: names are a friends-only privilege.
 */
export function holderNamesVisibleTo(role: ViewerRole, showHolderNames: boolean): boolean {
  if (role === 'BLOCKED') return false
  if (role === 'OWNER') return true
  if (role === 'FRIEND') return showHolderNames

  return false
}
