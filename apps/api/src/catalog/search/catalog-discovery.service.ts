import { Injectable } from '@nestjs/common'
import type {
  CatalogDiscoveryResponse,
  CatalogDiscoveryResult,
  CatalogDiscoveryScope,
  CatalogMatchKind,
  SearchPageSize,
} from '@bookswap/shared'
import { AccessService } from '../../access/access.service'
import { copyVisibleTo, type ViewerRole } from '../../access/visibility'
import { PrismaService } from '../../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../../users/user.mapper'
import { byEditionOrder, toEdition, toWork, toWorkAuthors } from '../catalog.mapper'
import { LocalMatches } from './local-matches.service'

type Location = CatalogDiscoveryResult['locations'][number]
type EligibleWork = { editionIds: Set<string>; locations: Map<string, Location> }

/** Searches physical, currently available copies without exposing invisible shelves. */
@Injectable()
export class CatalogDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly local: LocalMatches,
  ) {}

  async search(
    viewerId: string,
    query: string,
    page: number,
    pageSize: SearchPageSize,
    scope: CatalogDiscoveryScope,
  ): Promise<CatalogDiscoveryResponse> {
    const copies = await this.prisma.copy.findMany({
      where: { status: 'AVAILABLE' },
      select: {
        ownerId: true,
        currentHolderId: true,
        editionId: true,
        visibility: true,
        edition: { select: { workId: true } },
        owner: { select: { ...PUBLIC_USER_FIELDS, libraryVisibility: true } },
      },
    })

    const ownerIds = [...new Set(copies.map((copy) => copy.ownerId))].filter(
      (ownerId) => ownerId !== viewerId,
    )
    const relations = await this.access.relationsWith(viewerId, ownerIds)
    const eligible = new Map<string, EligibleWork>()

    for (const copy of copies) {
      if (copy.currentHolderId !== copy.ownerId) continue

      const relation = relations.get(copy.ownerId)
      const role: ViewerRole =
        copy.ownerId === viewerId
          ? 'OWNER'
          : relation === 'FRIENDS'
            ? 'FRIEND'
            : relation === 'BLOCKED_BY_ME' || relation === 'BLOCKED_ME'
              ? 'BLOCKED'
              : 'OTHER'

      if (scope === 'CIRCLE' && role !== 'OWNER' && role !== 'FRIEND') continue
      if (!copyVisibleTo(role, copy.owner.libraryVisibility, copy.visibility)) continue

      const workId = copy.edition.workId
      let work = eligible.get(workId)

      if (work === undefined) {
        work = { editionIds: new Set(), locations: new Map() }
        eligible.set(workId, work)
      }

      work.editionIds.add(copy.editionId)

      const previous = work.locations.get(copy.ownerId)

      work.locations.set(copy.ownerId, {
        owner: toPublicUser(copy.owner),
        relation: role === 'OWNER' ? 'SELF' : role === 'FRIEND' ? 'FRIEND' : 'OTHER',
        availableCopies: (previous?.availableCopies ?? 0) + 1,
      })
    }

    const matches = await this.local.rank(query, {
      authors: false,
      allowedWorkIds: [...eligible.keys()],
      allowedEditionIds: [...eligible.values()].flatMap((work) => [...work.editionIds]),
    })
    const total = matches.works.length
    const from = (page - 1) * pageSize
    const pageRows = matches.works.slice(from, from + pageSize)
    const ids = pageRows.map((row) => row.id)
    const matchKinds = new Map<string, CatalogMatchKind>(
      pageRows.map((row) => [
        row.id,
        matches.byIsbn ? 'ISBN' : row.titleScore >= row.authorScore ? 'TITLE' : 'AUTHOR',
      ]),
    )
    const works = await this.prisma.work.findMany({
      where: { id: { in: ids }, mergedIntoId: null },
      include: {
        authors: { include: { author: true } },
        editions: { include: { translation: true } },
      },
    })
    const byId = new Map(works.map((work) => [work.id, work]))

    const results: CatalogDiscoveryResult[] = ids.flatMap((id) => {
      const work = byId.get(id)
      const inventory = eligible.get(id)

      if (work === undefined || inventory === undefined) return []

      return [
        {
          work: toWork(work),
          authors: toWorkAuthors(work.authors),
          editions: work.editions
            .filter((edition) => inventory.editionIds.has(edition.id))
            .map((edition) => toEdition(edition, work))
            .sort(byEditionOrder),
          matchedOn: matchKinds.get(id) ?? 'TITLE',
          locations: [...inventory.locations.values()].sort(
            (left, right) =>
              relationOrder(left.relation) - relationOrder(right.relation) ||
              left.owner.displayName.localeCompare(right.owner.displayName),
          ),
        },
      ]
    })

    return { results, page, pageSize, scope, total, hasMore: total > page * pageSize }
  }
}

function relationOrder(relation: Location['relation']): number {
  if (relation === 'SELF') return 0
  if (relation === 'FRIEND') return 1
  return 2
}
