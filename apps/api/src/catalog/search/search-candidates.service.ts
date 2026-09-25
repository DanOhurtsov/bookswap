import { Injectable } from '@nestjs/common'
import {
  splitSearchPage,
  type SearchCandidatesResponse,
  type WorkDetailResponse,
} from '@bookswap/shared'
import { PrismaService } from '../../prisma/prisma.service'
import {
  byEditionOrder,
  toEdition,
  toTranslation,
  toWork,
  toWorkAuthors,
  type EditionRow,
} from '../catalog.mapper'
import { LocalMatches } from './local-matches.service'

const WITH_CANDIDATE_RELATIONS = {
  authors: { include: { author: true } },
  editions: { include: { translation: true } },
  translations: true,
} as const

/**
 * Етап 7c: бекенд-пошук кандидатів для майстра додавання (§6.3, крок 2) —
 * «можливо, це одна з цих?».
 *
 * Ранжування — те саме, що й у `/catalog/search` (`LocalMatches`): другий шлях
 * пошуку в базі — це другий шанс розійтися з першим і мовчки не знайти
 * дублікат, якого перший знаходить. Відмінність цього ендпоінта — форма
 * відповіді (кандидат несе й `Translation`, не лише `Edition`).
 *
 * Тепер він ГОРТАЄТЬСЯ (`page`/`pageSize`, той самий `splitSearchPage`, що й у
 * `/catalog/search`): майстер показує той самий спільний список. Перевірка
 * дублікатів кличе його без параметрів — це перший екран (топ-10), і від
 * сторінки, яку гортає людина, вона не залежить.
 */
@Injectable()
export class SearchCandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly local: LocalMatches,
  ) {}

  async search(query: string, page: number, pageSize: number): Promise<SearchCandidatesResponse> {
    const matches = await this.local.rank(query, { authors: false })
    const total = matches.works.length
    const { localFrom, localCount } = splitSearchPage({ page, pageSize, localTotal: total })
    const ids = matches.works.slice(localFrom, localFrom + localCount).map((row) => row.id)

    return {
      candidates: await this.hydrate(ids),
      page,
      pageSize,
      total,
      hasMore: total > page * pageSize,
    }
  }

  /**
   * Порядок відновлюється за списком id, а не за тим, у якому їх повернув
   * `findMany` (`IN (...)` порядку не гарантує) — так само, як у загальному
   * пошуку. `mergedIntoId: null` у `where` прибирає змержені твори з видачі
   * (DoD 7c) для обох гілок одразу.
   */
  private async hydrate(workIds: string[]): Promise<WorkDetailResponse[]> {
    if (workIds.length === 0) return []

    const works = await this.prisma.work.findMany({
      where: { id: { in: workIds }, mergedIntoId: null },
      include: WITH_CANDIDATE_RELATIONS,
    })

    const byId = new Map(works.map((work) => [work.id, work]))

    return workIds.flatMap((id) => {
      const work = byId.get(id)

      if (work === undefined) return []

      const editionsPerTranslation = countEditionsPerTranslation(work.editions)

      return [
        {
          work: toWork(work),
          authors: toWorkAuthors(work.authors),
          translations: work.translations.map((translation) =>
            toTranslation(translation, editionsPerTranslation.get(translation.id) ?? 0),
          ),
          editions: work.editions.map((edition) => toEdition(edition, work)).sort(byEditionOrder),
        },
      ]
    })
  }
}

/** Та сама лічба, що й у `CatalogService.getWork` — скільки видань має переклад. */
function countEditionsPerTranslation(editions: EditionRow[]): Map<string, number> {
  const counts = new Map<string, number>()

  for (const edition of editions) {
    if (edition.translationId === null) continue

    counts.set(edition.translationId, (counts.get(edition.translationId) ?? 0) + 1)
  }

  return counts
}
