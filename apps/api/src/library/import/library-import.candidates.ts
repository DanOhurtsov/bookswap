import { Injectable } from '@nestjs/common'
import { SEARCH_CANDIDATES_LIMIT, type LibraryImportCandidate } from '@bookswap/shared'
import { escapeLikePattern } from '../../catalog/search-text'
import { TextNormalizer } from '../../catalog/text-normalizer'
import { Prisma } from '../../generated/prisma/client'
import type { PrismaService } from '../../prisma/prisma.service'

/**
 * Stage 8f-2, R7: "is this book maybe one of these?" for every row of a file at
 * once — two statements, whatever the row count.
 *
 * The ranking expression is copied from `rankWorks`, deliberately verbatim. A
 * second way of scoring the same catalog would drift from the first, and then
 * the import would miss duplicates the add-book wizard finds — the failure R7
 * names when it says candidate resolution must reuse the existing contract.
 */

/** A transaction client: the trigram threshold is pinned per transaction. */
export type CandidateClient = Pick<PrismaService, 'work' | '$queryRaw'>

interface RankedRow {
  term: string
  workId: string
}

@Injectable()
export class LibraryImportCandidateFinder {
  constructor(private readonly normalizer: TextNormalizer) {}

  /** Keyed by the title that was searched for; titles with no match are absent. */
  async find(
    client: CandidateClient,
    titles: readonly string[],
  ): Promise<Map<string, LibraryImportCandidate[]>> {
    const byTitle = new Map<string, LibraryImportCandidate[]>()
    const terms = await this.termsOf(client, titles)

    if (terms.size === 0) return byTitle

    const ranked = await rankCandidates(client, [...new Set(terms.values())])
    const works = await this.hydrate(client, ranked)

    for (const [title, term] of terms) {
      const candidates = ranked
        .filter((row) => row.term === term)
        .flatMap((row) => works.get(row.workId) ?? [])

      if (candidates.length > 0) byTitle.set(title, candidates)
    }

    return byTitle
  }

  /** One statement for every distinct title (`bookswap_norm`, §4.4). */
  private async termsOf(
    client: CandidateClient,
    titles: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(titles)]
    const terms = new Map<string, string>()

    if (unique.length === 0) return terms

    const normalized = await this.normalizer.normalizeMany(unique, client)

    unique.forEach((title, index) => {
      const term = normalized[index]

      if (term !== undefined && term !== '') terms.set(title, term)
    })

    return terms
  }

  /** One statement for every candidate of every row, authors in `position` order (R10a). */
  private async hydrate(
    client: CandidateClient,
    ranked: readonly RankedRow[],
  ): Promise<Map<string, LibraryImportCandidate[]>> {
    const ids = [...new Set(ranked.map((row) => row.workId))]

    if (ids.length === 0) return new Map()

    const works = await client.work.findMany({
      where: { id: { in: ids }, mergedIntoId: null },
      select: {
        id: true,
        title: true,
        authors: { select: { author: { select: { name: true } } }, orderBy: { position: 'asc' } },
      },
    })

    return new Map(
      works.map((work) => [
        work.id,
        [{ workId: work.id, title: work.title, authors: work.authors.map((l) => l.author.name) }],
      ]),
    )
  }
}

/**
 * A `VALUES` list of search terms, each joined to its own top-N through a
 * `LATERAL` — the batched form of `rankWorks`, with the same `%` operator (so
 * the same GIN index and the same pinned threshold) and the same tie-break.
 */
function rankCandidates(client: CandidateClient, terms: readonly string[]): Promise<RankedRow[]> {
  const values = Prisma.join(
    terms.map((term) => Prisma.sql`(${term}::text, ${`%${escapeLikePattern(term)}%`}::text)`),
  )

  return client.$queryRaw<RankedRow[]>`
    SELECT q.term AS term, c."workId" AS "workId"
    FROM (VALUES ${values}) AS q(term, pattern)
    CROSS JOIN LATERAL (
      SELECT w.id AS "workId",
             GREATEST(
               similarity(w."titleNorm", q.term),
               COALESCE(MAX(similarity(a."nameNorm", q.term)), 0)
             ) AS score
      FROM "Work" w
      LEFT JOIN "WorkAuthor" wa ON wa."workId" = w.id
      LEFT JOIN "Author" a ON a.id = wa."authorId"
      WHERE w."mergedIntoId" IS NULL
        AND (
          w."titleNorm" % q.term
          OR a."nameNorm" % q.term
          OR w."titleNorm" LIKE q.pattern
          OR a."nameNorm" LIKE q.pattern
        )
      GROUP BY w.id
      ORDER BY score DESC, w."titleNorm" ASC
      LIMIT ${SEARCH_CANDIDATES_LIMIT}
    ) c
  `
}
