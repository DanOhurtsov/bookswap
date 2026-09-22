import { PrismaPg } from '@prisma/adapter-pg'
import { Client } from 'pg'
import { PrismaClient } from '../../src/generated/prisma/client'
import {
  applyMigration,
  applyMigrations,
  createScratchDatabase,
  SCRATCH_CLEANUP_TIMEOUT_MS,
  listMigrationDirs,
  type ScratchDatabase,
} from './migration-scratch'

/**
 * Executable evidence for
 * `docs/runbooks/catalog-correction-migration-rollback.md` §B step 3 — the
 * recovery that fills in `WorkAuthor.position`/`Translation.createdById`
 * after a §A/§B window left some rows NULL, restores `NOT NULL`, and only
 * then hands traffic to a version that reads these columns as required.
 * `RECOVERY_SQL` below is quoted VERBATIM in the runbook: if it ever changes
 * here, the runbook's copy must change identically, or the two have diverged.
 *
 * What this specifically proves, on real migration-shaped data on a scratch
 * database (never the shared `_test` one or dev):
 *
 * - recovery is ONE transaction that locks writers out first, waits for an
 *   already-in-flight writer to finish, fills the NULLs, restores `NOT
 *   NULL`, and only then commits — no window where a fresh writer can slip
 *   a new NULL row in between "filled" and "required again";
 * - a manually reordered `position` (not alphabetical — modelling a future
 *   8e-2 PATCH reorder) survives recovery untouched, both for the rows that
 *   already had a position and for the ones that didn't;
 * - a NULL row added during the §A/§B window is appended after the existing
 *   max position, not spliced in, and not re-sorted against the manual order;
 * - the `CatalogRevision` audit row and `Work.revision` are untouched;
 * - once the transaction commits, the REAL generated `PrismaClient` — the
 *   same one `catalog.mapper.ts` uses — reads the affected rows without
 *   throwing, which is the actual "safe to open traffic to the new version"
 *   signal, not just "no NULL left" by raw SQL count.
 */
const REQUIRED_MIGRATION = '20260910231806_catalog_correction_audit_required'

/** §A of the runbook — same text as `catalog-correction-rollback.db-spec.ts`'s `UNDO_NOT_NULL_SQL`. */
const UNDO_NOT_NULL_SQL = `
ALTER TABLE "Translation" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "WorkAuthor" ALTER COLUMN "position" DROP NOT NULL;
`

/**
 * §B step 3 of the runbook, as ONE transaction — the exact text an operator
 * runs. In order:
 *
 * 1. `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` — blocks every other writer
 *    AND reader of these two tables, and itself blocks until any
 *    transaction already holding a conflicting lock (an in-flight writer)
 *    commits or rolls back. This is "stop writers and wait for their
 *    transactions to finish" as one SQL primitive, not a separate manual
 *    step an operator has to get right on their own.
 * 2. Creator recovery — safe to re-run any number of times: the
 *    `WHERE ... IS NULL` guard means it only ever fills a gap, never
 *    overwrites a `createdById` that is already set. Same text as the
 *    `BACKFILL:CREATOR:*` block in
 *    `20260910231627_catalog_correction_audit_schema/migration.sql`.
 * 3. Position recovery — deliberately NOT the original migration's blanket
 *    `BACKFILL:POSITION:*` query (which recomputes every row from scratch
 *    and would overwrite a manual reorder): this one only assigns a
 *    position to rows where it is still NULL, appending them after the
 *    work's current highest position — same role → name
 *    (`COLLATE "uk-x-icu"`) → authorId order the original backfill used —
 *    and never touches a row that already has one.
 * 4. Restore `NOT NULL` — in the SAME transaction, still holding the lock,
 *    so no writer can slip a fresh NULL row in between "filled" and
 *    "required again". `COMMIT` is the only point traffic may resume.
 */
const RECOVERY_SQL = `
BEGIN;

LOCK TABLE "Translation", "WorkAuthor" IN ACCESS EXCLUSIVE MODE;

UPDATE "Translation" t
SET "createdById" = w."createdById"
FROM "Work" w
WHERE w."id" = t."workId" AND t."createdById" IS NULL;

WITH existing_max AS (
  SELECT "workId", MAX("position") AS max_position
  FROM "WorkAuthor"
  WHERE "position" IS NOT NULL
  GROUP BY "workId"
),
missing AS (
  SELECT
    wa."workId",
    wa."authorId",
    wa."role",
    ROW_NUMBER() OVER (
      PARTITION BY wa."workId"
      ORDER BY
        CASE wa."role"
          WHEN 'AUTHOR' THEN 0
          WHEN 'CO_AUTHOR' THEN 1
          WHEN 'EDITOR' THEN 2
          WHEN 'ILLUSTRATOR' THEN 3
        END,
        a."name" COLLATE "uk-x-icu",
        wa."authorId"
    ) AS rank
  FROM "WorkAuthor" wa
  JOIN "Author" a ON a."id" = wa."authorId"
  WHERE wa."position" IS NULL
)
UPDATE "WorkAuthor" wa
SET "position" = COALESCE(existing_max.max_position + 1, 0) + (missing.rank - 1)
FROM missing
LEFT JOIN existing_max ON existing_max."workId" = missing."workId"
WHERE wa."workId" = missing."workId"
  AND wa."authorId" = missing."authorId"
  AND wa."role" = missing."role";

ALTER TABLE "Translation" ALTER COLUMN "createdById" SET NOT NULL;
ALTER TABLE "WorkAuthor" ALTER COLUMN "position" SET NOT NULL;

COMMIT;
`

describe('Stage 8e-1 rollback runbook §B step 3 — locked, position-preserving recovery on real migrations', () => {
  let scratch: ScratchDatabase
  let client: Client

  const ownerId = 'recovery-owner'
  const workId = 'recovery-work-1'
  const zenithId = 'recovery-author-zenith'
  const alphaId = 'recovery-author-alpha'
  const betaId = 'recovery-author-beta'
  const inflightId = 'recovery-author-inflight'
  const revisionId = 'recovery-revision-1'
  const oldTranslationId = 'recovery-translation-old-format'

  async function seedLegacyState(): Promise<void> {
    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES ($1, $2, $3, $4)`,
      [ownerId, 'recovery-owner@example.com', 'test-placeholder', 'Recovery Owner'],
    )
    // Work.revision = 3: models a Work that already went through edits
    // before this recovery — proves recovery does not touch revision either.
    await client.query(
      `INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById", revision)
       VALUES ($1, $2, $3, $4, $5, 3)`,
      [workId, 'Recovery Work', 'recovery work', 'uk', ownerId],
    )

    // A manual, non-alphabetical order: "Zenith" at 0, "Alpha" at 1 — the
    // opposite of what any name-based backfill would compute. Models a
    // future 8e-2 PATCH reorder that recovery must not undo.
    for (const [id, name, position] of [
      [zenithId, 'Zenith Author', 0],
      [alphaId, 'Alpha Author', 1],
    ] as const) {
      await client.query(`INSERT INTO "Author" (id, name, "nameNorm") VALUES ($1, $2, $3)`, [
        id,
        name,
        name.toLowerCase(),
      ])
      await client.query(
        `INSERT INTO "WorkAuthor" ("workId", "authorId", role, position) VALUES ($1, $2, 'AUTHOR', $3)`,
        [workId, id, position],
      )
    }

    await client.query(
      `INSERT INTO "CatalogRevision"
         (id, "entityType", "entityId", "actorId", before, after, "fromRevision", "toRevision")
       VALUES ($1, 'WORK', $2, $3, $4, $5, 2, 3)`,
      [
        revisionId,
        workId,
        ownerId,
        JSON.stringify({ title: 'Recovery Work (before)' }),
        JSON.stringify({ title: 'Recovery Work' }),
      ],
    )

    // §A: drop the NOT NULL requirement.
    await client.query(UNDO_NOT_NULL_SQL)

    // Old-format rows written during the §A/§B window: a NEW author link
    // with no position, and a NEW Translation with no createdById.
    await client.query(`INSERT INTO "Author" (id, name, "nameNorm") VALUES ($1, $2, $3)`, [
      betaId,
      'Beta Author',
      'beta author',
    ])
    await client.query(
      `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, 'AUTHOR')`,
      [workId, betaId],
    )
    await client.query(
      `INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang") VALUES ($1, $2, $3, $4, $5)`,
      [oldTranslationId, workId, 'Old Format Translator', 'en', 'uk'],
    )
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('recovery')
    client = scratch.client

    // Full real migration history — current production shape.
    await applyMigrations(client, listMigrationDirs())

    await seedLegacyState()
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('waits for an in-flight writer to finish, then blocks new writers, before recovery proceeds', async () => {
    // The row this writer inserts still needs a real Author to join against
    // in the position-recovery query below — named to sort AFTER "Beta
    // Author" so it doesn't change betaId's expected final position (2) in
    // the next test.
    await client.query(`INSERT INTO "Author" (id, name, "nameNorm") VALUES ($1, $2, $3)`, [
      inflightId,
      'Inflight Author',
      'inflight author',
    ])

    // A second connection to the SAME scratch database, simulating an
    // old/external writer whose transaction is still open when recovery
    // is asked to start.
    const inflightWriter = new Client({ connectionString: scratch.url })

    await inflightWriter.connect()

    try {
      await inflightWriter.query('BEGIN')
      await inflightWriter.query(
        `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, 'AUTHOR')`,
        [workId, inflightId],
      )
      // Uncommitted on purpose: this row holds a ROW EXCLUSIVE lock on
      // "WorkAuthor", which conflicts with the ACCESS EXCLUSIVE lock
      // `RECOVERY_SQL` opens with — recovery must queue behind it.

      let recoveryCommitted = false
      const recovery = client.query(RECOVERY_SQL).then(() => {
        recoveryCommitted = true
      })

      // Give the recovery statement a moment to actually reach and block on
      // the lock request before asserting it hasn't finished.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(recoveryCommitted).toBe(false)

      // A brand new writer attempting to write now must ALSO queue — the
      // lock recovery is waiting to acquire already excludes it, even
      // before recovery itself has run a single statement.
      const newWriterAttempt = new Client({ connectionString: scratch.url })

      await newWriterAttempt.connect()

      let newWriteCommitted = false

      try {
        const newWrite = newWriterAttempt
          .query(
            `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, 'CO_AUTHOR')`,
            [workId, inflightId],
          )
          .then(() => {
            newWriteCommitted = true
          })

        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(newWriteCommitted).toBe(false)

        // Now let the in-flight writer's transaction finish — this is what
        // recovery (and, behind it, the new writer) was waiting on.
        await inflightWriter.query('COMMIT')

        await recovery
        expect(recoveryCommitted).toBe(true)

        // The queued writer's own INSERT can now proceed — but it hits the
        // NOT NULL recovery just restored (no `position` supplied), so its
        // failure here is expected and simply unblocks the connection.
        await expect(newWrite).rejects.toThrow()
      } finally {
        await newWriterAttempt.end()
      }
    } finally {
      await inflightWriter.end()
    }
  })

  it('preserves the manual (non-alphabetical) order of rows that already had a position', async () => {
    const { rows } = await client.query<{ authorId: string; position: number }>(
      `SELECT "authorId", position FROM "WorkAuthor" WHERE "workId" = $1 AND "authorId" = ANY($2)`,
      [workId, [zenithId, alphaId]],
    )
    const byId = new Map(rows.map((row) => [row.authorId, row.position]))

    expect(byId.get(zenithId)).toBe(0)
    expect(byId.get(alphaId)).toBe(1)
  })

  it('appends the row that was NULL after the existing max position, gaplessly', async () => {
    const { rows } = await client.query<{ position: number }>(
      `SELECT position FROM "WorkAuthor" WHERE "workId" = $1 AND "authorId" = $2`,
      [workId, betaId],
    )

    expect(rows[0]?.position).toBe(2)
  })

  it('leaves no NULL position/createdById anywhere for this work', async () => {
    const positions = await client.query<{ count: string }>(
      `SELECT count(*) FROM "WorkAuthor" WHERE "workId" = $1 AND position IS NULL`,
      [workId],
    )
    const creators = await client.query<{ count: string }>(
      `SELECT count(*) FROM "Translation" WHERE "workId" = $1 AND "createdById" IS NULL`,
      [workId],
    )

    expect(positions.rows[0]?.count).toBe('0')
    expect(creators.rows[0]?.count).toBe('0')
  })

  it('backfills the old-format Translation.createdById from the parent Work', async () => {
    const { rows } = await client.query<{ createdById: string }>(
      `SELECT "createdById" FROM "Translation" WHERE id = $1`,
      [oldTranslationId],
    )

    expect(rows[0]?.createdById).toBe(ownerId)
  })

  it('does not touch Work.revision or the CatalogRevision audit row — recovery is not a second edit', async () => {
    const work = await client.query<{ revision: number }>(
      `SELECT revision FROM "Work" WHERE id = $1`,
      [workId],
    )

    expect(work.rows[0]?.revision).toBe(3)

    const revision = await client.query<{
      before: unknown
      after: unknown
      fromRevision: number
      toRevision: number
    }>(`SELECT before, after, "fromRevision", "toRevision" FROM "CatalogRevision" WHERE id = $1`, [
      revisionId,
    ])

    expect(revision.rows[0]).toEqual({
      before: { title: 'Recovery Work (before)' },
      after: { title: 'Recovery Work' },
      fromRevision: 2,
      toRevision: 3,
    })
  })

  it('reads back in the correct order: manual order preserved, appended row last', async () => {
    const { rows } = await client.query<{ authorId: string }>(
      `SELECT "authorId" FROM "WorkAuthor" WHERE "workId" = $1 AND "authorId" != $2 ORDER BY position`,
      [workId, inflightId],
    )

    expect(rows.map((row) => row.authorId)).toEqual([zenithId, alphaId, betaId])
  })

  it('the real required migration still applies cleanly — recovery already restored the same NOT NULL', async () => {
    await expect(applyMigration(client, REQUIRED_MIGRATION)).resolves.not.toThrow()

    const translationCol = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'Translation' AND column_name = 'createdById'`,
    )
    const positionCol = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'WorkAuthor' AND column_name = 'position'`,
    )

    expect(translationCol.rows[0]?.is_nullable).toBe('NO')
    expect(positionCol.rows[0]?.is_nullable).toBe('NO')
  })

  it('the real Prisma Client — the one catalog.mapper.ts actually uses — reads the recovered rows without throwing', async () => {
    // Not a raw SQL count: this is the concrete "safe to open traffic to the
    // new version" signal §A alone cannot give (round 2 of this runbook's
    // review) — the same generated client, typed exactly as
    // `catalog.mapper.ts`'s `WorkAuthorRow`/`TranslationRow` expect
    // (`position: number`, `createdById: string`, never nullable).
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: scratch.url }) })

    try {
      const workAuthors = await prisma.workAuthor.findMany({
        where: { workId, authorId: { not: inflightId } },
        orderBy: { position: 'asc' },
        select: { authorId: true, position: true },
      })

      expect(workAuthors.map((row) => row.authorId)).toEqual([zenithId, alphaId, betaId])
      expect(workAuthors.map((row) => row.position)).toEqual([0, 1, 2])

      const translation = await prisma.translation.findUniqueOrThrow({
        where: { id: oldTranslationId },
        select: { createdById: true },
      })

      expect(translation.createdById).toBe(ownerId)
    } finally {
      await prisma.$disconnect()
    }
  })
})
