import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  LIBRARY_IMPORT_MAX_FILE_BYTES,
  LIBRARY_IMPORT_LIMITS,
  libraryImportCsvRowSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
  type LibraryImportFormat,
  type LibraryImportRejectedCells,
  type LibraryImportRowPatchRequest,
  type LibraryImportRowRecord,
  type LibraryImportRowValues,
} from '@bookswap/shared'
import { AnalyticsService } from '../../analytics/analytics.service'
import { LookupService } from '../../catalog/lookup/lookup.service'
import { ApiException } from '../../common/api.exception'
import { isUniqueViolationOn } from '../../common/prisma-errors'
import { PrismaService } from '../../prisma/prisma.service'
import { readLibraryImportFile, type LibraryImportFileError } from './library-import-file'
import {
  libraryImportFieldErrors,
  mergeFieldErrors,
  type LibraryImportParsedRow,
} from './library-import-rows'
import {
  assessLibraryImportCommit,
  exceedsCopyCap,
  type LibraryImportCommitPlan,
} from './library-import.commit'
import {
  duplicateErrors,
  fieldErrorsOf,
  toDraftResponse,
  toDraftVersion,
  toRowRecord,
  type RowDraftInput,
} from './library-import.draft'
import { libraryImportNotReady } from './library-import.errors'
import {
  LibraryImportRepository,
  type CommitLibraryImportResult,
  type ImportReadClient,
  type OwnedLibraryImport,
} from './library-import.repository'
import { LibraryImportWriter } from './library-import.writer'
import {
  LibraryImportResolver,
  type ResolvableRow,
  type ResolvedRow,
} from './library-import.resolver'

/**
 * Stage 8f-2 (R4–R7, §4): parse a CSV, resolve it against the catalog, keep the
 * draft — and change nothing else.
 *
 * The one invariant behind every method here: **a preview writes no domain
 * data**. `Work`, `Author`, `WorkAuthor`, `Translation`, `Edition`, `Copy` and
 * `Loan` are read, never written; the only writes are the import draft itself
 * and the ISBN lookup cache, both of which the plan allows.
 *
 * The second invariant is about order: external calls happen BEFORE any
 * transaction opens. Inside the lock everything is local — the draft's rows,
 * local editions, the lookup cache, candidate ranking — so a slow provider can
 * never hold a row lock.
 *
 * That ordering alone does NOT make a slow operation safe, and an earlier
 * version of this file wrongly claimed it did. A `RETRY` that waits on a
 * provider while its row is skipped would come back and apply itself to the
 * skipped row, silently undoing the skip: the lock makes the two operations
 * take turns, it does not make the second one still correct. What makes it
 * correct is `expectedRowVersion` — checked once before the external call and
 * again under the lock, against the row as it is at that moment (agreed 8f-2
 * concurrency contract).
 */
/** Outcomes of the external pass that just ran, handed into in-transaction resolution. */
type FetchedLookups = Awaited<ReturnType<LookupService['lookupMany']>>

@Injectable()
export class LibraryImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: LibraryImportRepository,
    private readonly resolver: LibraryImportResolver,
    private readonly lookup: LookupService,
    private readonly writer: LibraryImportWriter,
    private readonly analytics: AnalyticsService,
  ) {}

  async preview(input: {
    ownerId: string
    format: LibraryImportFormat
    contentBase64: string
  }): Promise<LibraryImportDraftResponse> {
    const { ownerId, format, contentBase64 } = input
    const parsed = await readLibraryImportFile(format, decodeContent(format, contentBase64))

    if (!parsed.ok) throw fileError(parsed.error)

    const now = new Date()
    const existing = await this.repository.findOwnedByHash({
      ownerId,
      sourceHash: parsed.sourceHash,
      now,
    })

    // R6: the same file twice is the same import. A live draft keeps the edits
    // already made on it, and a committed one keeps its summary — neither is
    // re-resolved, so a repeated upload costs no provider call at all.
    if (existing !== null && existing.import.status !== 'EXPIRED') {
      return toDraftResponse(existing)
    }

    const rows = await this.resolveRows(parsed.rows.map(toDraftInput))
    const saved = await this.repository.saveDraft({
      ownerId,
      sourceHash: parsed.sourceHash,
      copyCount: parsed.copyCount,
      rows,
      now,
    })

    if (saved.outcome === 'CREATED' || saved.outcome === 'REVIVED') {
      return toDraftResponse({ import: saved.import, rows })
    }

    // A concurrent preview of the same file won the race: its draft is the one
    // that exists, and ours is discarded rather than layered on top of it.
    return this.getDraft(ownerId, saved.import.id)
  }

  async getDraft(ownerId: string, importId: string): Promise<LibraryImportDraftResponse> {
    const owned = await this.repository.findOwned({ ownerId, importId, now: new Date() })

    return toDraftResponse(this.requireLive(owned))
  }

  /**
   * One row changes, the whole draft is recomputed and returned (R12).
   *
   * Nothing is written outside the single locked transaction below, so a request
   * that turns out to be invalid — an unknown row, a `Work` that was never
   * offered — leaves the draft exactly as it was.
   */
  async patchRow(input: {
    ownerId: string
    importId: string
    rowNumber: number
    request: LibraryImportRowPatchRequest
  }): Promise<LibraryImportDraftResponse> {
    const { ownerId, importId, rowNumber, request } = input
    const before = this.requireLive(
      await this.repository.findOwned({ ownerId, importId, now: new Date() }),
    )
    if (before.import.status === 'COMMITTED') throw committed()

    const target = before.rows.find((row) => row.rowNumber === rowNumber)

    if (target === undefined) throw notFound()

    // Before the provider, not only after it: an operation that is already
    // stale must not spend an external request, and the person who sent it
    // should hear about the conflict now rather than five seconds later.
    requireCurrentRow(target, request.expectedRowVersion)

    // Outside the transaction, on purpose: this is the only step that may talk
    // to a provider, and it only fills the shared ISBN cache.
    const fetched = await this.prefetch(applyAction(target, request), request)
    const updated = await this.repository.updateRows({
      ownerId,
      importId,
      now: new Date(),
      apply: ({ client, owned }) => this.rebuild({ client, owned, rowNumber, request, fetched }),
    })

    return toDraftResponse(this.requireLive(updated))
  }

  /**
   * Stage 8g (R6c): the draft becomes books, once, atomically.
   *
   * Everything that decides whether this may happen is checked INSIDE the
   * transaction, under the import lock, against the draft and the catalog as
   * they are at that moment — the client's `expectedDraftVersion` included. A
   * check that ran before the lock would only describe a past the commit is not
   * about.
   *
   * The two things that deliberately sit outside it: an already-committed
   * import answers before any other test (so a retry after a lost response
   * works even with its rows gone and its TTL spent), and analytics is written
   * after the transaction commits, best-effort, per 8a.
   */
  async commit(input: {
    ownerId: string
    importId: string
    expectedDraftVersion: string
  }): Promise<LibraryImportDraftResponse> {
    const { ownerId, importId, expectedDraftVersion } = input
    let plan: LibraryImportCommitPlan | undefined
    let createdCopyIds: readonly string[] = []

    const committed = await this.runCommit({
      ownerId,
      importId,
      apply: async ({ client, owned }) => {
        this.requireLive(owned)
        requireCurrentDraft(owned.rows, expectedDraftVersion)

        const assessed = assessLibraryImportCommit(owned.rows)

        plan = assessed.plan

        const [blocker] = assessed.blockers

        if (blocker !== undefined) throw libraryImportNotReady(blocker)
        if (exceedsCopyCap(assessed.plan.copyCount)) throw tooManyCopies(assessed.plan.copyCount)

        createdCopyIds = await this.writer.write({ client, ownerId, plan: assessed.plan })

        return createdCopyIds
      },
      plan: () => plan,
    })

    if (committed.outcome === 'COMMITTED') await this.recordAddedCopies(ownerId, createdCopyIds)

    // The rows are gone with the commit, so the answer is the summary over an
    // empty draft — the same document shape `GET` and `PATCH` return (R12), so
    // the client replaces its cached draft with it and nothing has to know that
    // this particular response came from a commit.
    return toDraftResponse({ import: committed.import, rows: [] })
  }

  /**
   * Runs the commit transaction and turns one specific race into one specific
   * answer.
   *
   * Requirement B (agreed): a unique violation on the ISBN index aborts the
   * WHOLE transaction — nothing more is attempted inside it, because inside an
   * aborted transaction nothing can be. Only that constraint becomes
   * `EDITION_APPEARED`; any other Prisma failure keeps its own identity rather
   * than being dressed up as a catalog race the user could act on.
   */
  private async runCommit(input: {
    ownerId: string
    importId: string
    apply: Parameters<LibraryImportRepository['commit']>[0]['apply']
    plan: () => LibraryImportCommitPlan | undefined
  }): Promise<CommitLibraryImportResult> {
    try {
      const result = await this.repository.commit({
        ownerId: input.ownerId,
        importId: input.importId,
        now: new Date(),
        apply: input.apply,
      })

      if (result === null) throw notFound()

      return result
    } catch (error) {
      if (!isUniqueViolationOn(error, EDITION_ISBN_UNIQUE)) throw error

      // The transaction is already rolled back, so this reads the catalog as it
      // now is — which is the only way to name the rows honestly: the violation
      // itself says which index broke, never which value did.
      throw await this.editionAppeared(input.plan())
    }
  }

  /** Which rows of the plan an ISBN now exists for. */
  private async editionAppeared(plan: LibraryImportCommitPlan | undefined): Promise<ApiException> {
    const chains = plan?.chains ?? []
    const isbns = chains.map((chain) => chain.isbn13)
    const taken =
      isbns.length === 0
        ? []
        : await this.prisma.edition.findMany({
            where: { isbn13: { in: isbns } },
            select: { isbn13: true },
          })
    const takenIsbns = new Set(taken.flatMap((edition) => edition.isbn13 ?? []))
    const named = chains
      .filter((chain) => takenIsbns.has(chain.isbn13))
      .flatMap((chain) => chain.rowNumbers)
    // The winner of the race may itself have been rolled back by the time we
    // look, so "the index refused it" is the stronger evidence: fall back to
    // every row the plan would have created rather than to an empty list.
    const rowNumbers = named.length > 0 ? named : chains.flatMap((chain) => chain.rowNumbers)

    if (rowNumbers.length === 0) return notFound()

    return libraryImportNotReady({
      reason: 'EDITION_APPEARED',
      rowNumbers: [...rowNumbers].sort((left, right) => left - right),
    })
  }

  /**
   * R3/R5: one `BOOK_ADDED` with `method: 'CSV'` per created copy, after the
   * commit.
   *
   * Best-effort by 8a's design: `record()` never throws, so a failure here
   * cannot turn an import that already happened into an error the user sees. It
   * is also idempotent — the dedupe key is derived from the copy id — so a
   * repeated attempt writes nothing twice.
   *
   * This is where the constant-statement promise of the transaction stops
   * applying to the request as a whole: `record()` writes one event per call by
   * 8a's contract, so a 500-copy import ends with 500 inserts here. Batching
   * them would mean changing that contract, which is 8a's to change.
   */
  private async recordAddedCopies(ownerId: string, copyIds: readonly string[]): Promise<void> {
    // `allSettled`, not `all`: 8a promises that `record()` resolves whatever
    // happens, but the books are already committed by the time we get here, and
    // an import must not be reported as failed because a promise about
    // analytics was broken. The guarantee belongs to the caller that has
    // something to lose, not to the callee that made the promise.
    await Promise.allSettled(
      copyIds.map((copyId) =>
        this.analytics.record({
          type: 'BOOK_ADDED',
          subjectUserId: ownerId,
          domainEntityId: copyId,
          properties: { method: 'CSV' },
        }),
      ),
    )
  }

  /** A preview resolves outside any lock; the read-only transaction only pins the trigram threshold. */
  private async resolveRows(inputs: RowDraftInput[]): Promise<LibraryImportRowRecord[]> {
    const resolvable = toResolvable(inputs, new Map())
    const isbns = resolvable.map((row) => row.values.isbn13)
    const unresolved = await this.resolver.unresolvedIsbns(this.prisma, isbns)
    const fetched = await this.lookup.lookupMany(unresolved)
    const resolved = await this.prisma.$transaction((tx) =>
      this.resolver.resolve(tx, resolvable, fetched),
    )
    const duplicates = duplicateErrors(inputs)

    return inputs.map((row) =>
      toRowRecord(row, duplicates.get(row.rowNumber), resolved.get(row.rowNumber)),
    )
  }

  /**
   * Warms the ISBN cache for the row this PATCH will touch, so the work inside
   * the lock is purely local. `SKIP` needs nothing: skipping a row asks no
   * question of anyone.
   */
  private async prefetch(
    values: LibraryImportRowValues | null,
    request: LibraryImportRowPatchRequest,
  ): Promise<FetchedLookups> {
    if (values === null || request.action === 'SKIP') return new Map()

    const unresolved = await this.resolver.unresolvedIsbns(this.prisma, [values.isbn13])

    return this.lookup.lookupMany(unresolved)
  }

  /** Recomputes every row of the draft from the stored rows plus this one change. */
  private async rebuild(context: {
    client: ImportReadClient
    owned: OwnedLibraryImport
    rowNumber: number
    request: LibraryImportRowPatchRequest
    fetched: FetchedLookups
  }): Promise<LibraryImportRowRecord[]> {
    const { client, owned, rowNumber, request, fetched } = context

    // Re-checked under the lock, against the draft as it is now: everything
    // above ran without one. The draft may have expired, been revived by a
    // concurrent preview (new rows, new versions), or simply been edited.
    this.requireLive(owned)

    if (owned.import.status === 'COMMITTED') throw committed()

    const target = owned.rows.find((row) => row.rowNumber === rowNumber)

    if (target === undefined) throw notFound()

    requireCurrentRow(target, request.expectedRowVersion)

    const inputs = owned.rows.map((row) =>
      row.rowNumber === rowNumber ? patchedInput(row, request) : storedInput(row),
    )
    const chosen = choiceOf(owned.rows, rowNumber, request)
    const resolvable = toResolvable(inputs, chosen)
    const resolved = await this.resolver.resolve(client, resolvable, fetched)
    const duplicates = duplicateErrors(inputs)

    if (request.action === 'CHOOSE') requireOfferedChoice(resolved.get(rowNumber), request.workId)

    return inputs.map((row) =>
      toRowRecord(row, duplicates.get(row.rowNumber), resolved.get(row.rowNumber)),
    )
  }

  /** A foreign id and a missing one answer the same 404; an expired draft says so. */
  private requireLive(owned: OwnedLibraryImport | null): OwnedLibraryImport {
    if (owned === null) throw notFound()

    if (owned.import.status === 'EXPIRED') {
      throw new ApiException(
        API_ERROR_CODES.IMPORT_EXPIRED,
        'Чернетка імпорту застаріла. Надішліть файл ще раз.',
        HttpStatus.GONE,
      )
    }

    return owned
  }
}

function decodeContent(format: LibraryImportFormat, contentBase64: string): Uint8Array {
  const bytes = Buffer.from(contentBase64, 'base64')

  // The schema already rejected anything that is not standard padded base64, so
  // this cannot silently decode to a shorter file. The transport cap is above
  // every per-format cap on purpose, so a file modestly over its own limit still
  // reaches its reader and is answered with its real size.
  if (bytes.byteLength > LIBRARY_IMPORT_LIMITS.maxRequestBytes) {
    throw new ApiException(
      API_ERROR_CODES.IMPORT_TOO_LARGE,
      'Файл завеликий',
      HttpStatus.PAYLOAD_TOO_LARGE,
      { limit: 'BYTES', max: LIBRARY_IMPORT_MAX_FILE_BYTES[format], actual: bytes.byteLength },
    )
  }

  return bytes
}

const FILE_ERROR_MESSAGES = {
  [API_ERROR_CODES.IMPORT_TOO_LARGE]: 'Файл перевищує дозволений розмір',
  [API_ERROR_CODES.IMPORT_INVALID_CSV]: 'Файл не є коректним CSV імпорту',
  [API_ERROR_CODES.IMPORT_INVALID_XLSX]: 'Файл не є коректною книгою Excel для імпорту',
} as const

function fileError(error: LibraryImportFileError): ApiException {
  const tooLarge = error.code === API_ERROR_CODES.IMPORT_TOO_LARGE

  return new ApiException(
    error.code,
    FILE_ERROR_MESSAGES[error.code],
    tooLarge ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
    error.details,
  )
}

function notFound(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Імпорт не знайдено', HttpStatus.NOT_FOUND)
}

/**
 * The row must still be the one the client acted on.
 *
 * No payload goes into the error: the client re-reads the draft and decides
 * again, and a 409 is not a place to leak a private note.
 */
function requireCurrentRow(row: LibraryImportRowRecord, expected: string): void {
  if (row.payload.rowVersion === expected) return

  throw new ApiException(
    API_ERROR_CODES.IMPORT_ROW_CONFLICT,
    'Рядок змінився після того, як ви його прочитали. Перечитайте чернетку й повторіть дію.',
    HttpStatus.CONFLICT,
  )
}

/** The Postgres index behind `Edition.isbn13 @unique` — see the init migration. */
const EDITION_ISBN_UNIQUE = 'Edition_isbn13_key'

/**
 * The draft must still be the one the client decided to commit (R6c).
 *
 * Same reasoning as `requireCurrentRow`, one level up: the import lock only
 * makes two operations take turns, it does not make the second one right. A
 * commit computed from a draft that a second tab has since edited would import
 * something nobody reviewed.
 */
function requireCurrentDraft(rows: readonly LibraryImportRowRecord[], expected: string): void {
  if (toDraftVersion(rows) === expected) return

  throw libraryImportNotReady({ reason: 'DRAFT_CHANGED' })
}

/**
 * R6a/R7a: the 500-copy cap, re-checked against what would really be created.
 *
 * Kept as `IMPORT_TOO_LARGE` rather than folded into `IMPORT_NOT_READY`: it is
 * the same limit the parser reports, and the client already knows how to say
 * this one.
 */
function tooManyCopies(actual: number): ApiException {
  return new ApiException(
    API_ERROR_CODES.IMPORT_TOO_LARGE,
    'Забагато примірників для одного імпорту',
    HttpStatus.PAYLOAD_TOO_LARGE,
    { limit: 'COPIES', max: LIBRARY_IMPORT_LIMITS.maxCopies, actual },
  )
}

function committed(): ApiException {
  return new ApiException(
    API_ERROR_CODES.CONFLICT,
    'Імпорт уже завершено й не змінюється',
    HttpStatus.CONFLICT,
  )
}

/**
 * The chosen `Work` has to be one this row actually offered.
 *
 * Checked against the candidates just computed, not against the row's status: a
 * row with no candidates at all is "ready" either way, and without this check a
 * client could point its import at any work id in the database.
 */
function requireOfferedChoice(resolved: ResolvedRow | undefined, workId: string | null): void {
  if (workId === null) return
  if (resolved?.candidates.some((candidate) => candidate.workId === workId) === true) return

  throw new ApiException(
    API_ERROR_CODES.VALIDATION_ERROR,
    'Вибраний твір не входить до запропонованих для цього рядка',
    HttpStatus.BAD_REQUEST,
  )
}

function toDraftInput(row: LibraryImportParsedRow): RowDraftInput {
  return {
    rowNumber: row.rowNumber,
    cells: row.payload.cells,
    values: row.payload.values,
    fieldErrors: fieldErrorsOf(row.payload.errors),
    rejectedCells: row.payload.rejectedCells,
    skipped: false,
    // A brand new draft: every row is being written for the first time.
    rowVersion: undefined,
  }
}

function storedInput(row: LibraryImportRowRecord): RowDraftInput {
  return {
    rowNumber: row.rowNumber,
    cells: row.payload.cells,
    values: row.payload.values,
    fieldErrors: fieldErrorsOf(row.payload.errors),
    rejectedCells: row.payload.rejectedCells,
    skipped: row.status === 'SKIPPED',
    // Untouched by this action: its version survives the rewrite, so a
    // concurrent operation on THIS row is not refused for someone else's edit.
    rowVersion: row.payload.rowVersion,
  }
}

/**
 * The patched row, re-parsed through the very same cell schemas the file went
 * through: an edit cannot reach a state a CSV could not.
 */
function patchedInput(
  row: LibraryImportRowRecord,
  request: LibraryImportRowPatchRequest,
): RowDraftInput {
  const skipped = request.action === 'SKIP'
  // The row this action touches always gets a new version, even when the values
  // it writes happen to equal the old ones: A → B → A must still conflict with
  // an operation that read the first A.
  const rowVersion = undefined

  if (request.action !== 'EDIT') return { ...storedInput(row), skipped, rowVersion }

  const cells: LibraryImportCsvCells = { ...row.payload.cells, ...request.cells }
  const rejectedCells = keepRejections(row.payload.rejectedCells, request.cells)
  const parsed = libraryImportCsvRowSchema.safeParse(cells)
  const fieldErrors = mergeFieldErrors(
    parsed.success ? [] : libraryImportFieldErrors(parsed.error.issues),
    rejectedCells,
  )

  return {
    rowNumber: row.rowNumber,
    cells,
    // A surviving rejection keeps the row without values for the same reason a
    // failed cell does: its column has no answer, and the schema's default for
    // an empty cell is not one.
    values: parsed.success && fieldErrors.length === 0 ? parsed.data : null,
    fieldErrors,
    rejectedCells,
    skipped: false,
    rowVersion,
  }
}

/**
 * Which refused cells an edit leaves standing.
 *
 * Only the columns this edit actually wrote lose their rejection — that is the
 * explicit correction. Every other column keeps it, so editing a note cannot
 * quietly heal a quantity that held a date.
 */
function keepRejections(
  rejected: LibraryImportRejectedCells,
  edited: Partial<Record<string, string>>,
): LibraryImportRejectedCells {
  return Object.fromEntries(Object.entries(rejected).filter(([column]) => !(column in edited)))
}

function applyAction(
  row: LibraryImportRowRecord,
  request: LibraryImportRowPatchRequest,
): LibraryImportRowValues | null {
  return patchedInput(row, request).values
}

/**
 * Which `Work` each row has already settled on.
 *
 * A stored `CREATE_CHAIN` resolution carries the previous decision forward, so
 * an unrelated edit (a quantity, a note) does not make the owner choose again —
 * but only while the row still describes the same book. A changed ISBN, title,
 * author list or original language drops it: R5 is explicit that a changed ISBN
 * must not keep the edition the old one resolved to, and the same reasoning
 * covers the work.
 */
function choiceOf(
  rows: readonly LibraryImportRowRecord[],
  rowNumber: number,
  request: LibraryImportRowPatchRequest,
): Map<number, string | null> {
  const chosen = new Map<number, string | null>()

  for (const row of rows) {
    const resolution = row.payload.resolution

    if (resolution?.kind !== 'CREATE_CHAIN') continue

    const patched =
      row.rowNumber === rowNumber ? patchedInput(row, request).values : row.payload.values

    if (patched !== null && sameBook(row.payload.values, patched)) {
      chosen.set(row.rowNumber, resolution.workId)
    }
  }

  if (request.action === 'CHOOSE') chosen.set(rowNumber, request.workId)

  return chosen
}

/** Identity for the purposes of a stored choice: what decides which `Work` a row belongs to. */
function sameBook(before: LibraryImportRowValues | null, after: LibraryImportRowValues): boolean {
  if (before === null) return false

  return (
    before.isbn13 === after.isbn13 &&
    before.title === after.title &&
    before.origLang === after.origLang &&
    (before.authors ?? []).join(' ') === (after.authors ?? []).join(' ')
  )
}

function toResolvable(
  inputs: readonly RowDraftInput[],
  chosen: ReadonlyMap<number, string | null>,
): ResolvableRow[] {
  return inputs.flatMap((row) =>
    row.skipped || row.values === null || row.fieldErrors.length > 0
      ? []
      : [
          {
            rowNumber: row.rowNumber,
            values: row.values,
            chosenWorkId: chosen.get(row.rowNumber),
          },
        ],
  )
}
