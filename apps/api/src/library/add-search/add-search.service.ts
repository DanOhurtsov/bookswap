import { Injectable } from '@nestjs/common'
import {
  AUTO_SEARCH_RESULT_LIMIT,
  BOOK_LOOKUP_SOURCES,
  isValidIsbn13,
  normalizeIsbn13,
  type AddSearchEditionItem,
  type AddSearchExternalItem,
  type AddSearchExternalResponse,
  type AddSearchItem,
  type AddSearchResponse,
  type SpellingSuggestion,
  type AddSearchWorkItem,
  type CatalogMatchKind,
  type ExternalSearchResponse,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { byEditionOrder, toEdition, toWork, toWorkAuthors } from '../../catalog/catalog.mapper'
import { LocalMatches } from '../../catalog/search/local-matches.service'
import { ExternalSearchService } from '../../catalog/search/external/external-search.service'
import type { ExternalBookSource } from '../../generated/prisma/enums'
import { PrismaService } from '../../prisma/prisma.service'

/** Один елемент локальної половини списку: видання, або твір, що ще не має жодного видання. */
interface LayoutRow {
  workId: string
  editionId: string | null
  matchedOn: CatalogMatchKind
}

/**
 * Пошук для сторінки додавання (docs/plan/fast-book-add.md, §6): одиниця списку — видання.
 *
 * Порядок і довжина списку визначаються ДО нарізання сторінки: ранжовані твори розгортаються в
 * видання (`layout`), і лише потім береться `[from, from + pageSize)`. Тому `total` точний, а жодне
 * видання не губиться й не дублюється між сторінками. Дедуплікація в браузері не потрібна.
 *
 * Приватність: єдине, що залежить від користувача, — власні лічильники примірників. Читаються
 * пакетно (один запит на сторінку), лише по `ownerId = користувач`.
 */
@Injectable()
export class AddSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly local: LocalMatches,
    private readonly external: ExternalSearchService,
  ) {}

  async search(
    userId: string,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<AddSearchResponse> {
    const [layout, spellingSuggestion] = await Promise.all([
      this.layout(query),
      this.spellingSuggestion(query),
    ])
    const from = (page - 1) * pageSize
    const rows = layout.slice(from, from + pageSize)

    return {
      items: await this.hydrate(userId, rows),
      page,
      pageSize,
      total: layout.length,
      hasMore: layout.length > page * pageSize,
      ...spellingSuggestion,
    }
  }

  /**
   * Зовнішня половина того самого списку: ділить сторінку за довжиною локальної частини в виданнях.
   *
   * Запис, що вже є НАШИМ виданням (за ISBN чи підтвердженим посиланням), але його не знайшов локальний пошук
   * за цим запитом, підставляється на місце ДО нарізання сторінки (`matchLocal`) і показується як локальна
   * картка з власним станом «у моїй бібліотеці». Тож видання не зникає з результатів і не залежить від
   * доступності провайдера.
   */
  async searchExternal(
    userId: string,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<AddSearchExternalResponse> {
    const layout = await this.layout(query)
    const response = await this.external.search(query, page, pageSize, {
      localTotal: layout.length,
      matchLocal: (records) => this.matchLocal(records),
      spellingSuggestion: true,
    })

    return this.externalHalf(userId, response)
  }

  /**
   * Автопошук, локальна половина: ті самі `layout` і `hydrate`, але фіксована перша «сторінка» з
   * `AUTO_SEARCH_RESULT_LIMIT` елементів. `total` і `hasMore` лишаються точними — за ними сторінка
   * пропонує «Показати всі результати».
   */
  async suggest(userId: string, query: string): Promise<AddSearchResponse> {
    const [layout, spellingSuggestion] = await Promise.all([
      this.layout(query),
      this.spellingSuggestion(query),
    ])

    return {
      items: await this.hydrate(userId, layout.slice(0, AUTO_SEARCH_RESULT_LIMIT)),
      page: 1,
      pageSize: AUTO_SEARCH_RESULT_LIMIT,
      total: layout.length,
      hasMore: layout.length > AUTO_SEARCH_RESULT_LIMIT,
      ...spellingSuggestion,
    }
  }

  /**
   * Автопошук, зовнішня половина. Скільки й звідки питати — вирішує `ExternalSearchService.suggest`
   * (один запит, одне джерело, без дочитування); тут лише спільна з повним пошуком дедуплікація: запис,
   * що вже є нашим виданням, показується локальною карткою з власним станом, а ownership читається з БД
   * по `userId` і в кеш зовнішніх метаданих не потрапляє.
   */
  async suggestExternal(userId: string, query: string): Promise<AddSearchExternalResponse> {
    const layout = await this.layout(query)
    const response = await this.external.suggest(query, {
      limit: AUTO_SEARCH_RESULT_LIMIT,
      localTotal: layout.length,
      matchLocal: (records) => this.matchLocal(records),
      spellingSuggestion: true,
    })

    return this.externalHalf(userId, response)
  }

  private async externalHalf(
    userId: string,
    response: ExternalSearchResponse,
  ): Promise<AddSearchExternalResponse> {
    const localIds = response.results.flatMap((record) =>
      record.localEditionId === undefined ? [] : [record.localEditionId],
    )
    const local = await this.hydrateEditions(userId, localIds)

    return {
      items: response.results.flatMap((record): AddSearchExternalItem[] => {
        if (record.localEditionId === undefined) {
          return [{ kind: 'EXTERNAL', key: `external:${record.id}`, result: record }]
        }

        const item = local.get(record.localEditionId)

        return item === undefined ? [] : [item]
      }),
      sources: response.sources,
      page: response.page,
      pageSize: response.pageSize,
      more: response.more,
      complete: response.complete,
      ...(response.spellingSuggestion === undefined
        ? {}
        : { spellingSuggestion: response.spellingSuggestion }),
    }
  }

  /**
   * Які зовнішні записи вже є нашими виданнями. ISBN і підтверджене посилання, що вказують на РІЗНІ видання,
   * не зіставляються взагалі: запис лишається зовнішнім, а додавання поверне явний конфлікт ідентичності.
   */
  private async matchLocal(records: readonly ExternalSearchResult[]): Promise<Map<string, string>> {
    const isbns = records.flatMap((record) => (record.isbn13 === undefined ? [] : [record.isbn13]))
    const references = records.flatMap((record) => {
      const reference = referenceOf(record)

      return reference === undefined ? [] : [{ id: record.id, ...reference }]
    })
    const [byIsbn, byReference] = await Promise.all([
      isbns.length === 0
        ? []
        : this.prisma.edition.findMany({
            where: { isbn13: { in: isbns } },
            select: { id: true, isbn13: true },
          }),
      references.length === 0
        ? []
        : this.prisma.editionExternalReference.findMany({
            where: {
              OR: references.map(({ source, externalId }) => ({ source, externalId })),
            },
            select: { source: true, externalId: true, editionId: true },
          }),
    ])
    const idByIsbn = new Map(byIsbn.map((edition) => [edition.isbn13, edition.id]))
    const idByReference = new Map(
      byReference.map((row) => [`${row.source}:${row.externalId}`, row.editionId]),
    )
    const matches = new Map<string, string>()

    for (const record of records) {
      const viaIsbn = record.isbn13 === undefined ? undefined : idByIsbn.get(record.isbn13)
      const reference = referenceOf(record)
      const viaReference =
        reference === undefined
          ? undefined
          : idByReference.get(`${reference.source}:${reference.externalId}`)

      if (viaIsbn !== undefined && viaReference !== undefined && viaIsbn !== viaReference) continue

      const editionId = viaIsbn ?? viaReference

      if (editionId !== undefined) matches.set(record.id, editionId)
    }

    return matches
  }

  private async hydrateEditions(
    userId: string,
    editionIds: readonly string[],
  ): Promise<Map<string, AddSearchEditionItem>> {
    if (editionIds.length === 0) return new Map()

    const rows = await this.prisma.edition.findMany({
      where: { id: { in: [...editionIds] } },
      select: { id: true, workId: true },
    })
    const items = await this.hydrate(
      userId,
      rows.map((row) => ({ workId: row.workId, editionId: row.id, matchedOn: 'ISBN' as const })),
    )

    return new Map(
      items.flatMap((item): [string, AddSearchEditionItem][] =>
        item.kind === 'EDITION' ? [[item.edition.id, item]] : [],
      ),
    )
  }

  /**
   * Підказка прив'язана до запиту, для якого обчислена (`forQuery`): клієнт показує її, лише поки текст
   * у полі той самий, тож запізніла відповідь не виправляє новий текст.
   */
  private async spellingSuggestion(
    query: string,
  ): Promise<{ spellingSuggestion: SpellingSuggestion } | undefined> {
    const text = await this.local.spellingSuggestion(query)

    return text === undefined ? undefined : { spellingSuggestion: { forQuery: query, text } }
  }

  private async layout(query: string): Promise<LayoutRow[]> {
    const matches = await this.local.rank(query, { authors: false })

    if (matches.works.length === 0) return []

    const exactIsbn = isValidIsbn13(query) ? normalizeIsbn13(query) : null
    const editions = await this.prisma.edition.findMany({
      where: { workId: { in: matches.works.map((work) => work.id) } },
      select: { id: true, workId: true, year: true, publisher: true, isbn13: true },
    })
    const byWork = new Map<string, typeof editions>()

    for (const edition of editions) {
      const list = byWork.get(edition.workId)

      if (list === undefined) byWork.set(edition.workId, [edition])
      else list.push(edition)
    }

    return matches.works.flatMap((work): LayoutRow[] => {
      const matchedOn: CatalogMatchKind = matches.byIsbn
        ? 'ISBN'
        : work.titleScore >= work.authorScore
          ? 'TITLE'
          : 'AUTHOR'
      const own = [...(byWork.get(work.id) ?? [])].sort(
        (one, other) =>
          // Видання з точно введеним ISBN — першим: саме його людина мала на увазі.
          Number(other.isbn13 === exactIsbn) - Number(one.isbn13 === exactIsbn) ||
          byEditionOrder(one, other),
      )

      if (own.length === 0) return [{ workId: work.id, editionId: null, matchedOn }]

      return own.map((edition) => ({ workId: work.id, editionId: edition.id, matchedOn }))
    })
  }

  private async hydrate(userId: string, rows: LayoutRow[]): Promise<AddSearchItem[]> {
    if (rows.length === 0) return []

    const editionIds = rows.flatMap((row) => (row.editionId === null ? [] : [row.editionId]))
    const [works, editions, owned] = await Promise.all([
      this.prisma.work.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.workId))] } },
        include: { authors: { include: { author: true } } },
      }),
      this.prisma.edition.findMany({
        where: { id: { in: editionIds } },
        include: { translation: true },
      }),
      this.prisma.copy.findMany({
        where: { ownerId: userId, editionId: { in: editionIds } },
        select: { editionId: true, archivedAt: true },
      }),
    ])
    const workById = new Map(works.map((work) => [work.id, work]))
    const editionById = new Map(editions.map((edition) => [edition.id, edition]))
    const ownership = new Map<string, { activeCount: number; archivedCount: number }>()

    for (const copy of owned) {
      const counts = ownership.get(copy.editionId) ?? { activeCount: 0, archivedCount: 0 }

      if (copy.archivedAt === null) counts.activeCount += 1
      else counts.archivedCount += 1

      ownership.set(copy.editionId, counts)
    }

    return rows.flatMap((row): AddSearchItem[] => {
      const work = workById.get(row.workId)

      if (work === undefined) return []

      const base = {
        work: toWork(work),
        authors: toWorkAuthors(work.authors),
        matchedOn: row.matchedOn,
      }

      if (row.editionId === null) {
        return [{ kind: 'WORK', key: `work:${work.id}`, ...base } satisfies AddSearchWorkItem]
      }

      const edition = editionById.get(row.editionId)

      if (edition === undefined) return []

      return [
        {
          kind: 'EDITION',
          key: `edition:${edition.id}`,
          ...base,
          edition: toEdition(edition),
          ownership: ownership.get(edition.id) ?? { activeCount: 0, archivedCount: 0 },
        } satisfies AddSearchEditionItem,
      ]
    })
  }
}

/**
 * `<SOURCE>:<externalId>` → пара для зіставлення з підтвердженим посиланням. Лише відомі джерела; решта
 * записів зіставляється тільки за ISBN.
 */
function referenceOf(
  record: ExternalSearchResult,
): { source: ExternalBookSource; externalId: string } | undefined {
  const separator = record.id.indexOf(':')

  if (separator < 1) return undefined

  const source = record.id.slice(0, separator)
  const externalId = record.id.slice(separator + 1)

  return (BOOK_LOOKUP_SOURCES as readonly string[]).includes(source) && externalId !== ''
    ? { source: source as ExternalBookSource, externalId }
    : undefined
}
