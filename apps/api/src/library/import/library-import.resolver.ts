import { Injectable } from '@nestjs/common'
import type {
  LibraryImportCandidate,
  LibraryImportRowError,
  LibraryImportRowResolution,
  LibraryImportRowStatus,
  LibraryImportRowValues,
} from '@bookswap/shared'
import { pinSimilarityThreshold } from '../../catalog/catalog.search'
import { LookupService, type BatchLookupRowOutcome } from '../../catalog/lookup/lookup.service'
import type { PrismaService } from '../../prisma/prisma.service'
import { LibraryImportCandidateFinder, type CandidateClient } from './library-import.candidates'
import { buildResolvedCatalog, type CatalogAssembly } from './library-import.resolution'

/**
 * Stage 8f-2, R7: catalog resolution for a whole draft at once.
 *
 * Every step is one statement for the file rather than one per row — local
 * editions, cached lookups, candidate ranking, candidate hydration. A preview
 * issues the same number of queries for 3 rows and for 200, which is the
 * property the query-count tests pin and the reason this exists instead of a
 * loop around the single-book path.
 *
 * It performs NO writes. A preview that touched `Work`, `Translation`,
 * `Edition` or `Copy` would have broken R5 before anyone could review it.
 */

/** A transaction client: the trigram threshold is pinned per transaction. */
export type ResolverClient = CandidateClient & Pick<PrismaService, 'edition' | 'externalBookLookup'>

export interface ResolvableRow {
  rowNumber: number
  values: LibraryImportRowValues
  /** A `Work` the owner picked for this row; `null` is an explicit "create a new one". */
  chosenWorkId: string | null | undefined
}

export interface ResolvedRow {
  status: Extract<
    LibraryImportRowStatus,
    'READY_EXISTING_EDITION' | 'READY_CREATE_CHAIN' | 'NEEDS_REVIEW'
  >
  resolution: LibraryImportRowResolution | null
  errors: LibraryImportRowError[]
  /** The works this row could be — kept beside the status so a settled row still knows its options. */
  candidates: LibraryImportCandidate[]
}

interface ChainDraft {
  resolution: Extract<LibraryImportRowResolution, { kind: 'CREATE_CHAIN' }>
  title: string
}

@Injectable()
export class LibraryImportResolver {
  constructor(
    private readonly lookup: LookupService,
    private readonly candidateFinder: LibraryImportCandidateFinder,
  ) {}

  /**
   * Which ISBNs still have to be asked about outside.
   *
   * Split from {@link resolve} deliberately: the external pass runs before any
   * transaction opens, never inside one (R7). One query.
   */
  async unresolvedIsbns(client: ResolverClient, isbns: readonly string[]): Promise<string[]> {
    const local = await findLocalEditions(client, isbns)

    return [...new Set(isbns)].filter((isbn) => !local.has(isbn))
  }

  /**
   * `fetched` holds the outcomes of the external pass that just ran — the only
   * source of a `LOOKUP_UNAVAILABLE` reason, since nothing unfinished is ever
   * cached. Everything else is read from the cache, so this is safe to run
   * inside a transaction.
   */
  async resolve(
    client: ResolverClient,
    rows: readonly ResolvableRow[],
    fetched: ReadonlyMap<string, BatchLookupRowOutcome> = new Map(),
  ): Promise<Map<number, ResolvedRow>> {
    const resolved = new Map<number, ResolvedRow>()

    if (rows.length === 0) return resolved

    await pinSimilarityThreshold(client)

    const isbns = rows.map((row) => row.values.isbn13)
    const editions = await findLocalEditions(client, isbns)
    const missing = [...new Set(isbns)].filter((isbn) => !editions.has(isbn))
    const cached = await this.lookup.readCachedMany(missing, client)
    const chains = new Map<number, ChainDraft>()

    for (const row of rows) {
      const edition = editions.get(row.values.isbn13)

      if (edition !== undefined) {
        resolved.set(row.rowNumber, existingEdition(edition))
        continue
      }

      const outcome = fetched.get(row.values.isbn13) ?? cached.get(row.values.isbn13)
      const found = outcome?.kind === 'found' ? outcome.result : undefined
      const assembly = buildResolvedCatalog(row.values, found)

      if (assembly.kind !== 'complete') {
        resolved.set(row.rowNumber, needsDecision(outcome, assembly))
        continue
      }

      chains.set(row.rowNumber, {
        resolution: {
          kind: 'CREATE_CHAIN',
          workId: row.chosenWorkId ?? null,
          catalog: assembly.catalog,
        },
        title: assembly.catalog.work.title,
      })
    }

    await this.settleChains({ client, rows, chains, resolved })

    return resolved
  }

  /**
   * Agreed 8f-2 rule: a candidate is never taken silently. Even a single similar
   * `Work` makes the row `NEEDS_REVIEW` — an edition attached to a namesake's
   * work is far harder to notice, and to undo, than one question answered.
   */
  private async settleChains(input: {
    client: ResolverClient
    rows: readonly ResolvableRow[]
    chains: ReadonlyMap<number, ChainDraft>
    resolved: Map<number, ResolvedRow>
  }): Promise<void> {
    const { client, rows, chains, resolved } = input
    const titles = [...chains.values()].map((chain) => chain.title)
    const byTitle = await this.candidateFinder.find(client, titles)

    for (const row of rows) {
      const chain = chains.get(row.rowNumber)

      if (chain === undefined) continue

      const candidates = byTitle.get(chain.title) ?? []

      resolved.set(row.rowNumber, settle(row.chosenWorkId, chain, candidates))
    }
  }
}

/**
 * A row is ready when the owner has decided — explicitly, or because there was
 * nothing to decide.
 *
 * A stored choice that is no longer among the candidates (the work was merged
 * away, or the row was edited into a different book) is treated as no choice at
 * all, not carried along: the row simply asks again. A *requested* choice that
 * was never offered is a different matter — the service rejects that request
 * before anything is written, so it cannot reach this point.
 */
function settle(
  chosenWorkId: string | null | undefined,
  chain: ChainDraft,
  candidates: LibraryImportCandidate[],
): ResolvedRow {
  const offered =
    chosenWorkId === null || candidates.some((candidate) => candidate.workId === chosenWorkId)
  const workId = offered ? (chosenWorkId ?? null) : null

  if (offered || candidates.length === 0) {
    return {
      status: 'READY_CREATE_CHAIN',
      resolution: { ...chain.resolution, workId },
      errors: [],
      candidates,
    }
  }

  return {
    status: 'NEEDS_REVIEW',
    resolution: null,
    errors: [{ code: 'AMBIGUOUS_CATALOG_MATCH', candidates }],
    candidates,
  }
}

function existingEdition(edition: { id: string; workId: string }): ResolvedRow {
  return {
    status: 'READY_EXISTING_EDITION',
    resolution: { kind: 'EXISTING_EDITION', editionId: edition.id, workId: edition.workId },
    errors: [],
    candidates: [],
  }
}

/**
 * Two different answers to "why is this row not ready", kept apart on purpose:
 * `MISSING_CATALOG_DATA` asks for values, `CONFLICTING_CATALOG_DATA` asks for a
 * decision between values that are each valid. Telling someone to fill in a
 * cell they already filled in is how a person stops trusting the screen.
 */
function needsDecision(
  outcome: BatchLookupRowOutcome | undefined,
  assembly: Exclude<CatalogAssembly, { kind: 'complete' }>,
): ResolvedRow {
  const error: LibraryImportRowError =
    assembly.kind === 'incomplete'
      ? { code: 'MISSING_CATALOG_DATA', fields: assembly.missing }
      : { code: 'CONFLICTING_CATALOG_DATA', fields: assembly.fields }

  return {
    status: 'NEEDS_REVIEW',
    resolution: null,
    errors: [...lookupErrors(outcome), error],
    candidates: [],
  }
}

/**
 * A failed or unfinished lookup is reported as itself, never as "no such book".
 * An outcome missing entirely means a concurrent PATCH moved the row while this
 * one was calling providers — retryable too, and never a silent overwrite.
 */
function lookupErrors(outcome: BatchLookupRowOutcome | undefined): LibraryImportRowError[] {
  if (outcome === undefined) {
    return [{ code: 'LOOKUP_UNAVAILABLE', reason: 'CONCURRENT_UPDATE', retryable: true }]
  }

  if (outcome.kind === 'not-found') return [{ code: 'LOOKUP_NOT_FOUND' }]

  if (outcome.kind === 'unavailable') {
    return [{ code: 'LOOKUP_UNAVAILABLE', reason: outcome.reason, retryable: true }]
  }

  return []
}

/** One query, merged works excluded exactly as `searchByIsbn` excludes them. */
async function findLocalEditions(
  client: ResolverClient,
  isbns: readonly string[],
): Promise<Map<string, { id: string; workId: string }>> {
  const unique = [...new Set(isbns)]

  if (unique.length === 0) return new Map()

  const editions = await client.edition.findMany({
    where: { isbn13: { in: unique }, work: { mergedIntoId: null } },
    select: { id: true, isbn13: true, workId: true },
  })

  return new Map(
    editions.flatMap((edition) =>
      edition.isbn13 === null ? [] : [[edition.isbn13, { id: edition.id, workId: edition.workId }]],
    ),
  )
}
