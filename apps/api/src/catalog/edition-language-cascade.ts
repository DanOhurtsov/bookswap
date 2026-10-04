import type { PrismaService } from '../prisma/prisma.service'
import { toEditionRevisionSnapshot } from './catalog.mapper'

/**
 * Запис зміни мови/типу тексту видання з тим самим аудитом, що й PATCH видання: нова ревізія і
 * рядок `CatalogRevision` (before/after) на КОЖНЕ змінене видання. Викликається лише всередині
 * транзакції, що тримає блокування `Work` (`catalog-locks.ts`).
 *
 * `actorId = null` — зміну зробила не людина, а система: злиття творів через CLI. Каскад від PATCH
 * твору чи перекладу пише того, хто цей PATCH виконав.
 */
export type CascadeClient = Pick<PrismaService, 'edition' | 'catalogRevision'>

export interface EditionTextUpdate {
  id: string
  lang: string | null
}

export async function applyEditionTextUpdates(
  tx: CascadeClient,
  updates: readonly EditionTextUpdate[],
  actorId: string | null,
): Promise<void> {
  // Порядок за `id` — частина єдиного порядку блокувань.
  for (const update of [...updates].sort((one, other) => one.id.localeCompare(other.id))) {
    const before = await tx.edition.findUniqueOrThrow({ where: { id: update.id } })
    const after = await tx.edition.update({
      where: { id: update.id },
      data: {
        lang: update.lang,
        revision: { increment: 1 },
      },
    })

    await tx.catalogRevision.create({
      data: {
        entityType: 'EDITION',
        entityId: update.id,
        actorId,
        before: toEditionRevisionSnapshot(before),
        after: toEditionRevisionSnapshot(after),
        fromRevision: before.revision,
        toRevision: after.revision,
      },
    })
  }
}
