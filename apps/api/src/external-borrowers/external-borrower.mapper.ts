import type { ExternalBorrower } from '@bookswap/shared'
import type { ExternalBorrowerModel } from '../generated/prisma/models'

/** Явний перелік: `ownerId` і `retainUntil` назовні не йдуть. */
export function toExternalBorrower(row: ExternalBorrowerModel): ExternalBorrower {
  return {
    id: row.id,
    alias: row.alias,
    ownerInformedAt: row.ownerInformedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
