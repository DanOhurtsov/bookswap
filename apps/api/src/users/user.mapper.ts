import { LOAN_TERM_OPTIONS, type LoanTermDays, type Me, type PublicUser } from '@bookswap/shared'
import type { UserModel } from '../generated/prisma/models'

/**
 * Проєкції користувача назовні (§9).
 *
 * Перелік полів явний, а не `...user` із видаленням зайвого: при такому підході
 * кожне нове поле моделі — від `passwordHash` до `telegramChatId` — потрапляє в
 * API мовчки, і помітять це вже після витоку.
 */

/** Власнику — повний профіль. */
export function toMe(user: UserModel): Me {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    handle: user.handle,
    city: user.city,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    libraryVisibility: user.libraryVisibility,
    showHolderNames: user.showHolderNames,
    friendsOfFriendsAccess: user.friendsOfFriendsAccess,
    loanRequestsPaused: user.loanRequestsPaused,
    defaultLoanTermDays: toLoanTermDays(user.defaultLoanTermDays),
    ownerDueReminders: user.ownerDueReminders,
    createdAt: user.createdAt.toISOString(),
  }
}

/**
 * BS-148: the CHECK `user_default_loan_term_days` keeps the column within `LOAN_TERM_OPTIONS`; a value
 * outside it would mean the constraint is gone, and the contract must not carry it on.
 */
function toLoanTermDays(days: number | null): LoanTermDays | null {
  if (days === null) return null

  const term = LOAN_TERM_OPTIONS.find((option) => option === days)

  if (term === undefined) throw new Error(`Unexpected defaultLoanTermDays: ${String(days)}`)

  return term
}

/**
 * §9-проєкція «Інший» на рівні `select`.
 *
 * Обмеження стоїть уже в запиті, а не лише в мапері: зайві поля не мають доїжджати
 * навіть до процесу. Живе поряд із `toPublicUser`, бо це дві половини однієї
 * гарантії, і розʼїхатися вони не мають права.
 */
export const PUBLIC_USER_FIELDS = {
  id: true,
  displayName: true,
  handle: true,
  avatarUrl: true,
} as const

/**
 * Рівно те, що вибирає `PUBLIC_USER_FIELDS`.
 *
 * Іменований тип, щоб мапери інших модулів описували вкладеного користувача ним,
 * а не власною копією `Pick<…>`: копія переживе видалення поля з `PUBLIC_USER_FIELDS`
 * і почне вимагати колонку, якої в запиті вже немає.
 */
export type PublicUserRow = Pick<UserModel, 'id' | 'displayName' | 'handle' | 'avatarUrl'>

/**
 * §9: «Профіль | Інший | імʼя + аватар», plus the nickname (BS-148) — the person's public address.
 * Ні пошти, ні налаштувань видимості.
 */
export function toPublicUser(user: PublicUserRow): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    handle: user.handle,
    avatarUrl: user.avatarUrl,
  }
}
