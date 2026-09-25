import type { InvitationStatus } from '@bookswap/shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** D1: 14 днів для обох видів, без вибору користувача. */
export const INVITATION_TTL_MS = 14 * DAY_MS

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
