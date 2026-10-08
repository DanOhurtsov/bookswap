import type { ExternalBorrower } from '@bookswap/shared'
import type { ExternalBorrowerModel } from '../generated/prisma/models'

/**
 * Явний перелік: `ownerId` і `retainUntil` назовні не йдуть. Підтверджені гостем нікнейм/email
 * (10i.1) — приватні, лише власнику контакту (цей маршрут owner-only).
 */
export function toExternalBorrower(row: ExternalBorrowerModel): ExternalBorrower {
  return {
    id: row.id,
    alias: row.alias,
    ownerInformedAt: row.ownerInformedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    guestNickname: row.guestNickname,
    guestEmail: row.guestEmail,
    guestEmailVerifiedAt: row.guestEmailVerifiedAt?.toISOString() ?? null,
  }
}
