import type { InvitationStatus } from '@bookswap/shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** D1: 14 днів для обох видів, без вибору користувача. */
export const INVITATION_TTL_MS = 14 * DAY_MS

/**
 * D4 / Stage 10 (10g, Q5): вікно ліміту на одну адресу — те саме вікно, яким
 * `InvitationsService` рахує `perRecipient`, і те саме, після якого
 * `InviteEmailHashCleanupService` обнуляє `recipientEmailHash`: поки ліміт може ще
 * побачити цей запис, хеш лишається; щойно запис випадає з вікна ліміту — обнулення
 * безпечне. Поле спільне для звичайних email-запрошень Етапу 9 і гостьових (10g).
 */
export const EMAIL_RECIPIENT_LIMIT_WINDOW_MS = 7 * DAY_MS

export interface InvitationFacts {
  expiresAt: Date
  revokedAt: Date | null
  acceptedCount: number
  maxUses: number
}

/**
 * Чиста функція стану. Порядок значущий: відкликання сильніше за строк, строк —
 * за вичерпання, бо саме так запрошувач пояснює «чому не працює».
 */
export function invitationStatusOf(facts: InvitationFacts, now: Date): InvitationStatus {
  if (facts.revokedAt !== null) return 'REVOKED'
  if (facts.expiresAt.getTime() <= now.getTime()) return 'EXPIRED'
  if (facts.acceptedCount >= facts.maxUses) return 'EXHAUSTED'

  return 'ACTIVE'
}
