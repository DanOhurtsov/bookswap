import { Injectable } from '@nestjs/common'
import type {
  CatalogDiscoveryAvailability,
  CatalogDiscoveryResponse,
  CatalogDiscoveryResult,
  CatalogDiscoveryScope,
  CatalogDiscoveryTranslation,
  CatalogMatchKind,
  SearchPageSize,
} from '@bookswap/shared'
import { AnalyticsService } from '../../analytics/analytics.service'
import { PrismaService } from '../../prisma/prisma.service'
import { byEditionOrder, toEdition, toWork, toWorkAuthors } from '../catalog.mapper'
import { LocalMatches } from './local-matches.service'
import { groupByOwner, NetworkInventory, type InventoryCopy } from './network-inventory.service'

export interface DiscoveryQuery {
  q?: string | undefined
  page: number
  pageSize: SearchPageSize
  scope: CatalogDiscoveryScope
  availability: CatalogDiscoveryAvailability
  language?: string | undefined
  translation: CatalogDiscoveryTranslation
}

/** Searches physical copies visible to the viewer without exposing invisible shelves. */
@Injectable()
export class CatalogDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: NetworkInventory,
    private readonly analytics: AnalyticsService,
    private readonly local: LocalMatches,
  ) {}

  async search(viewerId: string, query: DiscoveryQuery): Promise<CatalogDiscoveryResponse> {
    const { page, pageSize, scope } = query
    const copies = await this.inventory.load(viewerId, {
      scope,
      availability: query.availability,
      language: query.language,
      translation: query.translation,
    })
    const eligible = new Map<string, InventoryCopy[]>()

    for (const item of copies) {
      const list = eligible.get(item.workId)

      if (list === undefined) eligible.set(item.workId, [item])
      else list.push(item)
    }

    const ranked = await this.rank(query.q, eligible)
    const total = ranked.rows.length
    const from = (page - 1) * pageSize
    const pageRows = ranked.rows.slice(from, from + pageSize)
    const ids = pageRows.map((row) => row.id)
    const works = await this.prisma.work.findMany({
      where: { id: { in: ids }, mergedIntoId: null },
      include: {
        authors: { include: { author: true } },
        editions: { include: { translation: true } },
      },
    })
    const byId = new Map(works.map((work) => [work.id, work]))

    const results: CatalogDiscoveryResult[] = pageRows.flatMap((row) => {
      const work = byId.get(row.id)
      const inventory = eligible.get(row.id)

      if (work === undefined || inventory === undefined) return []

      const editionIds = new Set(inventory.map((item) => item.copy.editionId))

      return [
        {
          work: toWork(work),
          authors: toWorkAuthors(work.authors),
          editions: work.editions
            .filter((edition) => editionIds.has(edition.id))
            .map((edition) => toEdition(edition, work))
            .sort(byEditionOrder),
          matchedOn: row.matchedOn,
          locations: groupByOwner(inventory),
        },
      ]
    })

    await this.recordSearch(viewerId, query, results)

    return { results, page, pageSize, scope, total, hasMore: total > page * pageSize }
  }

  /**
   * `discovery_searched` / `friend_book_found` (Етап 9, §2): лише текстовий пошук у
   * колі. Подія не несе ні запиту, ні назв, ні id книжок — тільки факт, що людина
   * шукала й що в її друзів знайшлася книжка, яку можна попросити. Раз на добу на
   * людину: ключ дедуплікації — доба.
   */
  private async recordSearch(
    viewerId: string,
    query: DiscoveryQuery,
    results: CatalogDiscoveryResult[],
  ): Promise<void> {
    if (query.scope !== 'CIRCLE' || query.q === undefined) return

    const day = new Date().toISOString().slice(0, 10)

    await this.analytics.record({
      type: 'DISCOVERY_SEARCHED',
      subjectUserId: viewerId,
      domainEntityId: day,
      properties: {},
    })

    const found = results.some((result) =>
      result.locations.some(
        (location) => location.relation === 'FRIEND' && location.availableCopies > 0,
      ),
    )

    if (found) {
      await this.analytics.record({
        type: 'FRIEND_BOOK_FOUND',
        subjectUserId: viewerId,
        domainEntityId: day,
        properties: {},
      })
    }
  }

  /** З текстом — за релевантністю; без тексту — за назвою, детерміновано. */
  private async rank(
    q: string | undefined,
    eligible: Map<string, InventoryCopy[]>,
  ): Promise<{ rows: { id: string; matchedOn: CatalogMatchKind }[] }> {
    if (q === undefined) {
      const titles = await this.prisma.work.findMany({
        where: { id: { in: [...eligible.keys()] } },
        select: { id: true },
        orderBy: [{ titleNorm: 'asc' }, { id: 'asc' }],
      })

      return { rows: titles.map((work) => ({ id: work.id, matchedOn: 'TITLE' as const })) }
    }

    const matches = await this.local.rank(q, {
      authors: false,
      allowedWorkIds: [...eligible.keys()],
      allowedEditionIds: [...eligible.values()].flatMap((items) =>
        items.map((item) => item.copy.editionId),
      ),
    })

    return {
      rows: matches.works.map((row) => ({
        id: row.id,
        matchedOn: matches.byIsbn
          ? ('ISBN' as const)
          : row.titleScore >= row.authorScore
            ? ('TITLE' as const)
            : ('AUTHOR' as const),
      })),
    }
  }
}
