import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { LibraryImportResolvedCatalog } from '@bookswap/shared'
import { TextNormalizer } from '../../catalog/text-normalizer'
import { Prisma } from '../../generated/prisma/client'
import { libraryImportNotReady } from './library-import.errors'
import type { LibraryImportCommitPlan, PlannedChain } from './library-import.commit'
import type { ImportCommitClient } from './library-import.repository'

/**
 * Stage 8g (R6c): the domain half of a commit — every write, inside the caller's
 * transaction, or none of them.
 *
 * Three properties hold this together, and each of them is a bug that has been
 * reasoned about rather than a precaution:
 *
 * 1. **No external call.** Nothing here talks to a provider; resolution already
 *    happened at preview time and is stored on the rows. A slow third party can
 *    therefore never hold a row lock, which is the one thing R7 asks of any code
 *    that runs inside a transaction.
 * 2. **Existing `Work` rows are locked the way `MergeService` locks them** —
 *    `SELECT … FOR UPDATE` in `id` order — before their canonical state is even
 *    read. A batched read alone would be a snapshot with a gap after it: the
 *    merge could land between the check and the insert, and the new edition
 *    would be written onto a work that is no longer canonical.
 * 3. **Rows are linked by ids this code generates**, never by the position of a
 *    row in a `createManyAndReturn` result. Prisma does not promise that order,
 *    and a silent mismatch here would attach an edition to somebody else's work
 *    — the kind of wrong that no test notices until a reader does.
 */

/**
 * Explicit ids, and `randomUUID` rather than a cuid.
 *
 * The columns are plain `String`, so the format is free; what is not free is
 * knowing an id BEFORE the insert, which is what lets five tables be linked in
 * five statements instead of one statement per book. The repo has no cuid
 * generator among its dependencies, and adding one to gain a cosmetic match with
 * ids Postgres writes by default would be a dependency bought for appearances.
 */
function newId(): string {
  return randomUUID()
}

interface LockedWork {
  id: string
  origLang: string
  mergedIntoId: string | null
}

@Injectable()
export class LibraryImportWriter {
  constructor(private readonly normalizer: TextNormalizer) {}

  /**
   * Executes the plan and answers with the ids of the copies it created.
   *
   * The ids travel out because analytics needs them after the transaction
   * commits (8a is explicit that a product event is written after the domain
   * write, never inside it). Everything else this method knows stays here.
   */
  async write(context: {
    client: ImportCommitClient
    ownerId: string
    plan: LibraryImportCommitPlan
  }): Promise<string[]> {
    const { client, ownerId, plan } = context

    await this.assertCatalogUnchanged(client, plan)

    const workIdByIsbn = await this.createChains(client, ownerId, plan.chains)
    const copies = plan.copies.flatMap((copy) => {
      const editionId =
        copy.target.kind === 'EXISTING'
          ? copy.target.editionId
          : (workIdByIsbn.get(copy.target.isbn13)?.editionId ?? '')

      // Unreachable: every `CHAIN` target names an ISBN this plan just created.
      // Throwing beats writing a copy onto an empty edition id, which the FK
      // would refuse anyway with a message about nothing in particular.
      if (editionId === '') throw new Error('Commit plan referenced an edition it never created')

      return Array.from({ length: copy.quantity }, () => ({
        id: newId(),
        editionId,
        ownerId,
        // §5.3.2: a copy is born at home, so the holder is the owner.
        currentHolderId: ownerId,
        condition: copy.values.condition,
        visibility: copy.values.visibility,
        note: copy.values.note ?? null,
        acquiredAt: toDate(copy.values.acquiredAt),
      }))
    })

    await client.copy.createMany({ data: copies })

    return copies.map((copy) => copy.id)
  }

  /**
   * The catalog as it is NOW, not as the preview left it.
   *
   * Both checks below describe a draft that was reviewed against a catalog that
   * has since moved on. Neither is repaired silently: adopting the edition that
   * appeared would hang the book off a work the owner never chose, and following
   * `mergedIntoId` would write to a record the client never named — the same
   * reasoning `CanonicalWorkService.assertCanonical` gives for refusing.
   */
  private async assertCatalogUnchanged(
    client: ImportCommitClient,
    plan: LibraryImportCommitPlan,
  ): Promise<void> {
    const locked = await this.lockChosenWorks(client, plan.chains)

    for (const reason of ['WORK_MERGED', 'WORK_LANG_MISMATCH'] as const) {
      const rowNumbers = plan.chains
        .filter((chain) => chainFault(chain, locked) === reason)
        .flatMap((chain) => chain.rowNumbers)
        .sort((left, right) => left - right)

      if (rowNumbers.length > 0) throw libraryImportNotReady({ reason, rowNumbers })
    }

    const isbns = plan.chains.map((chain) => chain.isbn13)

    if (isbns.length === 0) return

    // One query for the whole plan: an `Edition` that appeared between the
    // preview and now, for an ISBN this commit is about to create.
    const taken = await client.edition.findMany({
      where: { isbn13: { in: isbns } },
      select: { isbn13: true },
    })
    const takenIsbns = new Set(taken.flatMap((edition) => edition.isbn13 ?? []))
    const appeared = plan.chains
      .filter((chain) => takenIsbns.has(chain.isbn13))
      .flatMap((chain) => chain.rowNumbers)
      .sort((left, right) => left - right)

    if (appeared.length > 0) {
      throw libraryImportNotReady({ reason: 'EDITION_APPEARED', rowNumbers: appeared })
    }
  }

  /**
   * Locks every existing `Work` this commit will add to, in `id` order.
   *
   * The same lock, in the same order, that `MergeService.lockWorks` and
   * `CatalogService.patchWork` take — which is what makes the two orders both
   * correct rather than merely unlikely to collide. Merge first: we queue here,
   * then read `mergedIntoId` and refuse. Commit first: merge queues, and when it
   * runs it moves the edition we just created along with the rest of them.
   *
   * `ORDER BY "id"` is the deadlock guard: two operations touching an
   * overlapping set of works take the rows in the same sequence.
   */
  private async lockChosenWorks(
    client: ImportCommitClient,
    chains: readonly PlannedChain[],
  ): Promise<Map<string, LockedWork>> {
    const workIds = [...new Set(chains.flatMap((chain) => chain.workId ?? []))].sort()

    if (workIds.length === 0) return new Map()

    await client.$queryRaw`
      SELECT "id" FROM "Work"
      WHERE "id" IN (${Prisma.join(workIds)})
      ORDER BY "id"
      FOR UPDATE
    `

    const works = await client.work.findMany({
      where: { id: { in: workIds } },
      select: { id: true, origLang: true, mergedIntoId: true },
    })

    return new Map(works.map((work) => [work.id, work]))
  }

  /**
   * Creates the new chains and returns, per ISBN, the edition its copies go on.
   *
   * Five `createMany` statements for the whole import — the count does not grow
   * with the number of rows. Order is the dependency order of §3's chain:
   * `Author → Work → WorkAuthor → Translation → Edition`.
   */
  private async createChains(
    client: ImportCommitClient,
    ownerId: string,
    chains: readonly PlannedChain[],
  ): Promise<Map<string, { editionId: string }>> {
    const editionByIsbn = new Map<string, { editionId: string }>()

    if (chains.length === 0) return editionByIsbn

    const newWorkChains = chains.filter((chain) => chain.workId === null)
    // One round trip for every title and every author name in the import: the
    // rule lives in Postgres (`bookswap_norm`), and a second implementation in
    // TypeScript would silently disagree with `titleNorm` — see `search-text.ts`.
    const titles = newWorkChains.map((chain) => chain.catalog.work.title)
    const authorNames = newWorkChains.flatMap((chain) => chain.catalog.work.authors)
    const normalized = await this.normalizer.normalizeMany([...titles, ...authorNames], client)
    const titleNorms = normalized.slice(0, titles.length)
    const nameNorms = normalized.slice(titles.length)

    const authors: { id: string; name: string; nameNorm: string; nameLatin: null }[] = []
    const works: {
      id: string
      title: string
      titleNorm: string
      origLang: string
      firstPubYear: number | null
      createdById: string
    }[] = []
    const workAuthors: { workId: string; authorId: string; role: 'AUTHOR'; position: number }[] = []
    const workIdByChain = new Map<PlannedChain, string>()
    let nameCursor = 0

    newWorkChains.forEach((chain, index) => {
      const workId = newId()
      const titleNorm = titleNorms[index]

      if (titleNorm === undefined) throw new Error('Нормалізація назви не повернула значення')

      workIdByChain.set(chain, workId)
      works.push({
        id: workId,
        title: chain.catalog.work.title,
        titleNorm,
        origLang: chain.catalog.work.origLang,
        firstPubYear: chain.catalog.work.firstPubYear,
        createdById: ownerId,
      })

      // R10a: `position` follows the order the authors were given, and R4 gives
      // every imported name the `AUTHOR` role. Namesakes are NOT merged (R6c):
      // each name becomes its own `Author`, here and in `createWork` alike.
      chain.catalog.work.authors.forEach((name, position) => {
        const nameNorm = nameNorms[nameCursor]

        nameCursor += 1

        if (nameNorm === undefined)
          throw new Error('Нормалізація імені автора не повернула значення')

        const authorId = newId()

        authors.push({ id: authorId, name, nameNorm, nameLatin: null })
        workAuthors.push({ workId, authorId, role: 'AUTHOR', position })
      })
    })

    const translations: {
      id: string
      workId: string
      translator: string
      lang: string
      sourceLang: string
      year: number | null
      isAbridged: boolean
      hasNotes: boolean
      notes: string | null
      createdById: string
    }[] = []
    const editions: {
      id: string
      workId: string
      translationId: string | null
      publisher: string | null
      year: number | null
      isbn13: string
      pageCount: number | null
      coverUrl: string | null
      format: LibraryImportResolvedCatalog['edition']['format']
      createdById: string
    }[] = []

    for (const chain of chains) {
      const workId = chain.workId ?? workIdByChain.get(chain)

      if (workId === undefined) throw new Error('Commit plan lost the work of a chain')

      // R6c: one `Translation` per chain that needs one — not one per row of the
      // ISBN group, and not one per copy. Existing translations are never reused
      // by matching their text: that would be a dedup rule nobody agreed to.
      const translationId = chain.catalog.translation === null ? null : newId()

      if (chain.catalog.translation !== null && translationId !== null) {
        translations.push({
          id: translationId,
          workId,
          ...chain.catalog.translation,
          createdById: ownerId,
        })
      }

      const editionId = newId()

      editions.push({
        id: editionId,
        workId,
        translationId,
        ...chain.catalog.edition,
        createdById: ownerId,
      })
      editionByIsbn.set(chain.isbn13, { editionId })
    }

    await client.author.createMany({ data: authors })
    await client.work.createMany({ data: works })
    await client.workAuthor.createMany({ data: workAuthors })
    await client.translation.createMany({ data: translations })
    await client.edition.createMany({ data: editions })

    return editionByIsbn
  }
}

/**
 * Why one chain cannot be written, or `undefined` when it can.
 *
 * A `Work` that is absent entirely is folded into `WORK_MERGED`: §6.3 keeps a
 * merged work forever and nothing else deletes one, so this arm is the
 * unreachable twin of the merged case — and if the impossible does happen, the
 * honest answer is still "the work you chose is not there to add to".
 */
function chainFault(
  chain: PlannedChain,
  locked: ReadonlyMap<string, LockedWork>,
): 'WORK_MERGED' | 'WORK_LANG_MISMATCH' | undefined {
  if (chain.workId === null) return undefined

  const work = locked.get(chain.workId)

  if (work === undefined || work.mergedIntoId !== null) return 'WORK_MERGED'

  // Agreed 8g check: a row whose edition language equals its `orig_lang`
  // resolves to an edition in the original language. Attaching that to a work
  // written in a different language would quietly assert something the file
  // never said — and would be invisible afterwards.
  return work.origLang === chain.catalog.work.origLang ? undefined : 'WORK_LANG_MISMATCH'
}

/** Same conversion as `LibraryService.addCopy`: a date-only cell is midnight UTC. */
function toDate(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(`${value}T00:00:00.000Z`)
}
