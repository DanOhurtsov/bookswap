import { Injectable } from '@nestjs/common'
import {
  OPEN_LOAN_STATUS,
  type CatalogDiscoveryAvailability,
  type CatalogDiscoveryScope,
  type CatalogDiscoveryTranslation,
  type CopyStatus,
  type NetworkCopy,
  type NetworkOwner,
  type PublicUser,
} from '@bookswap/shared'
import { AccessService } from '../../access/access.service'
import { copyVisibleTo, type ViewerRole } from '../../access/visibility'
import { canRequestCopy, expectedReturnOf } from '../../library/library.mapper'
import { PrismaService } from '../../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../../users/user.mapper'

export interface InventoryFilter {
  scope: CatalogDiscoveryScope
  availability: CatalogDiscoveryAvailability
  language?: string | undefined
  translation?: CatalogDiscoveryTranslation | undefined
  /** Один конкретний переклад: id або `null` для видання мовою оригіналу. */
  translationId?: string | null | undefined
  workId?: string | undefined
}

export interface InventoryCopy {
  copy: NetworkCopy
  owner: PublicUser
  relation: NetworkOwner['relation']
  workId: string
  language: string
  translator: string | null
}

/**
 * Єдине місце, де «примірники, які цей глядач бачить у своїй мережі» перетворюються
 * на відповідь. Так `/catalog/discover` і `/works/:id/holders` не можуть розійтися
 * в питаннях «доступний», «видимий» і «чи можна просити».
 *
 * Усе рішення приймається тут, на сервері: дружба й блок (через `AccessService`),
 * `libraryVisibility ∧ Copy.visibility` (матриця §9), статус `Copy`, поточний
 * власник (`currentHolderId`) і `canRequest` — тим самим предикатом, що й
 * `/users/:id/library`. Клієнт нічого з цього не вирішує.
 */
@Injectable()
export class NetworkInventory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async load(viewerId: string, filter: InventoryFilter): Promise<InventoryCopy[]> {
    const rows = await this.prisma.copy.findMany({
      where: {
        // `AVAILABLE` означає «вдома» гарантовано: `copy_available_is_home` у БД (§5.3.2).
        ...(filter.availability === 'AVAILABLE' ? { status: 'AVAILABLE' as const } : {}),
        edition: {
          work: {
            mergedIntoId: null,
            ...(filter.workId === undefined ? {} : { id: filter.workId }),
          },
          ...editionFilter(filter),
        },
      },
      select: {
        id: true,
        ownerId: true,
        currentHolderId: true,
        editionId: true,
        status: true,
        visibility: true,
        owner: { select: { ...PUBLIC_USER_FIELDS, libraryVisibility: true } },
        edition: {
          select: {
            workId: true,
            translationId: true,
            translation: { select: { lang: true, translator: true } },
            work: { select: { origLang: true } },
          },
        },
        // Лише відкриті лоани; з них береться тільки дата й «мій» запит — без позичальника.
        loans: {
          where: { status: { in: [...OPEN_LOAN_STATUS] } },
          select: { id: true, status: true, borrowerId: true, dueAt: true },
        },
      },
    })

    const ownerIds = [...new Set(rows.map((row) => row.ownerId))].filter(
      (ownerId) => ownerId !== viewerId,
    )
    const relations = await this.access.relationsWith(viewerId, ownerIds)
    const result: InventoryCopy[] = []

    for (const row of rows) {
      const relation = relations.get(row.ownerId)
      const role: ViewerRole =
        row.ownerId === viewerId
          ? 'OWNER'
          : relation === 'FRIENDS'
            ? 'FRIEND'
            : relation === 'BLOCKED_BY_ME' || relation === 'BLOCKED_ME'
              ? 'BLOCKED'
              : 'OTHER'

      if (filter.scope === 'CIRCLE' && role !== 'OWNER' && role !== 'FRIEND') continue
      if (!copyVisibleTo(role, row.owner.libraryVisibility, row.visibility)) continue

      const translation = row.edition.translation
      const status: CopyStatus = row.status

      result.push({
        copy: {
          id: row.id,
          editionId: row.editionId,
          translationId: row.edition.translationId,
          status,
          expectedReturnAt: expectedReturnOf({ status, loans: row.loans }),
          canRequest: canRequestCopy(row, role, viewerId),
        },
        owner: toPublicUser(row.owner),
        relation: role === 'OWNER' ? 'SELF' : role === 'FRIEND' ? 'FRIEND' : 'OTHER',
        workId: row.edition.workId,
        language: translation?.lang ?? row.edition.work.origLang,
        translator: translation?.translator ?? null,
      })
    }

    return result
  }
}

/** Мова, оригінал/переклад і конкретний переклад — умови на `Edition`. */
function editionFilter(filter: InventoryFilter) {
  const clauses: object[] = []

  if (filter.language !== undefined) {
    clauses.push({
      OR: [
        { translation: { is: { lang: filter.language } } },
        { translationId: null, work: { origLang: filter.language } },
      ],
    })
  }

  if (filter.translation === 'ORIGINAL') clauses.push({ translationId: null })
  if (filter.translation === 'TRANSLATED') clauses.push({ translationId: { not: null } })

  if (filter.translationId !== undefined) clauses.push({ translationId: filter.translationId })

  return clauses.length === 0 ? {} : { AND: clauses }
}

/** Групує видимі примірники за власником, зберігаючи порядок: свої, друзі, решта. */
export function groupByOwner(items: readonly InventoryCopy[]): NetworkOwner[] {
  const owners = new Map<string, NetworkOwner>()

  for (const item of items) {
    let entry = owners.get(item.owner.id)

    if (entry === undefined) {
      entry = { owner: item.owner, relation: item.relation, availableCopies: 0, copies: [] }
      owners.set(item.owner.id, entry)
    }

    entry.copies.push(item.copy)

    if (item.copy.status === 'AVAILABLE') entry.availableCopies += 1
  }

  return [...owners.values()].sort(
    (left, right) =>
      relationOrder(left.relation) - relationOrder(right.relation) ||
      left.owner.displayName.localeCompare(right.owner.displayName),
  )
}

function relationOrder(relation: NetworkOwner['relation']): number {
  if (relation === 'SELF') return 0
  if (relation === 'FRIEND') return 1
  return 2
}
