import { Injectable } from '@nestjs/common'
import {
  CATALOG_SEARCH_LIMIT,
  CATALOG_SEARCH_MAX_MATCHES,
  isValidIsbn13,
  normalizeIsbn13,
} from '@bookswap/shared'
import { PrismaService } from '../../prisma/prisma.service'
import {
  pinSimilarityThreshold,
  rankAuthors,
  rankWorks,
  type RankedAuthor,
  type RankedWork,
} from '../catalog.search'
import { escapeLikePattern } from '../search-text'
import { TextNormalizer } from '../text-normalizer'

/** Наші збіги запиту — те, з чого складається локальна частина спільного списку. */
export interface LocalMatchSet {
  /** Ранжовані збіги, не більше `CATALOG_SEARCH_MAX_MATCHES`; порядок тотальний. */
  works: RankedWork[]
  /** Порожній, якщо авторів не просили або запит — ISBN. */
  authors: RankedAuthor[]
  /** Запит був точним ISBN: єдиний збіг (якщо є) — збіг за ISBN, а не за назвою. */
  byIsbn: boolean
}

/**
 * Єдина матеріалізація локальних збігів запиту.
 *
 * Її потребують ТРИ ендпоінти: `/catalog/search`, `/catalog/search/candidates` і
 * `/catalog/search/external`. Останньому вона потрібна не для показу, а щоб
 * (1) знати `L` — скільки рядків спільного списку належить нашому каталогу
 * (`splitSearchPage`), і (2) відкинути зовнішні записи з ISBN, що вже є в наших
 * збігах, ДО нарізання сторінки. Одна реалізація на трьох — щоб ті не могли
 * розійтися в тому, що вважають «нашим збігом»: інакше сторінки склеювалися б
 * з різних списків.
 */
@Injectable()
export class LocalMatches {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: TextNormalizer,
  ) {}

  async rank(
    query: string,
    options: {
      authors: boolean
      allowedWorkIds?: readonly string[]
      allowedEditionIds?: readonly string[]
    },
  ): Promise<LocalMatchSet> {
    if (isValidIsbn13(query)) {
      return this.byIsbn(normalizeIsbn13(query), options.allowedWorkIds, options.allowedEditionIds)
    }

    if (options.allowedWorkIds?.length === 0) {
      return { works: [], authors: [], byIsbn: false }
    }

    const term = await this.normalizer.normalize(query)

    if (term === '') return { works: [], authors: [], byIsbn: false }

    const pattern = `%${escapeLikePattern(term)}%`

    // Обидва запити — в одній транзакції, бо поріг схожості фіксується саме на
    // транзакцію (`set_config(..., true)`).
    return this.prisma.$transaction(async (tx) => {
      await pinSimilarityThreshold(tx)

      const works = await rankWorks(
        tx,
        term,
        pattern,
        CATALOG_SEARCH_MAX_MATCHES,
        options.allowedWorkIds,
      )
      const authors = options.authors
        ? await rankAuthors(tx, term, pattern, CATALOG_SEARCH_LIMIT)
        : []

      return { works, authors, byIsbn: false }
    })
  }

  /**
   * ISBN-13 усіх видань названих творів — для дедуплікації зовнішніх записів.
   * Усіх збігів запиту, а не показаної сторінки: пряме посилання на третю сторінку
   * не бачило перших двох.
   */
  async isbnsOf(workIds: string[]): Promise<Set<string>> {
    if (workIds.length === 0) return new Set()

    const editions = await this.prisma.edition.findMany({
      where: { workId: { in: workIds }, isbn13: { not: null } },
      select: { isbn13: true },
    })

    return new Set(editions.flatMap((edition) => (edition.isbn13 === null ? [] : [edition.isbn13])))
  }

  /**
   * Точний збіг ISBN — щонайбільше ОДИН твір. Видання злитого твору збігом не є
   * (§6.3, R4).
   */
  private async byIsbn(
    isbn13: string,
    allowedWorkIds?: readonly string[],
    allowedEditionIds?: readonly string[],
  ): Promise<LocalMatchSet> {
    if (allowedWorkIds?.length === 0 || allowedEditionIds?.length === 0) {
      return { works: [], authors: [], byIsbn: true }
    }

    const edition = await this.prisma.edition.findFirst({
      where: {
        isbn13,
        work: { mergedIntoId: null },
        ...(allowedWorkIds === undefined ? {} : { workId: { in: [...allowedWorkIds] } }),
        ...(allowedEditionIds === undefined ? {} : { id: { in: [...allowedEditionIds] } }),
      },
      select: { workId: true },
    })

    return {
      works: edition === null ? [] : [{ id: edition.workId, titleScore: 1, authorScore: 0 }],
      authors: [],
      byIsbn: true,
    }
  }
}
