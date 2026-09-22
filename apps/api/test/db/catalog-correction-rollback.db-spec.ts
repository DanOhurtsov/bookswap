import type { Client } from 'pg'
import {
  applyMigrations,
  createScratchDatabase,
  SCRATCH_CLEANUP_TIMEOUT_MS,
  listMigrationDirs,
  type ScratchDatabase,
} from './migration-scratch'

/**
 * Executable evidence for
 * `docs/runbooks/catalog-correction-migration-rollback.md` §A/§B — run on its
 * own scratch database (see `migration-scratch.ts`), never the shared `_test`
 * one or the dev database. Two claims that runbook makes, verified here
 * instead of only asserted in prose:
 *
 * §B: reverting the app to a pre-Stage-8e-1 version while the DB stays on the
 * required migration is UNSAFE — the old app's `WorkAuthor`/`Translation`
 * inserts never set `position`/`createdById` (those columns didn't exist in
 * its own `schema.prisma`), and the required migration made both NOT NULL
 * with no default.
 *
 * §A: the forward migration the runbook gives operators to undo JUST the NOT
 * NULL requirement (`UNDO_NOT_NULL_SQL` below — the literal text, not a
 * paraphrase) restores that old-app write compatibility, applies cleanly on
 * top of real production-shaped data, and loses nothing: existing `Work`
 * data and `CatalogRevision` audit rows survive untouched.
 */
const UNDO_NOT_NULL_SQL = `
ALTER TABLE "Translation" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "WorkAuthor" ALTER COLUMN "position" DROP NOT NULL;
`

const NOT_NULL_VIOLATION = '23502'

describe('Stage 8e-1 rollback runbook, scenarios A and B — verified against real migrations', () => {
  let scratch: ScratchDatabase
  let client: Client
  const ownerId = 'rollback-owner'
  const workId = 'rollback-work-1'
  const authorId = 'rollback-author-1'
  const revisionId = 'rollback-revision-1'

  beforeAll(async () => {
    scratch = await createScratchDatabase('rollback')
    client = scratch.client

    // Full real migration history — the current production shape, required
    // migration included, not a hypothetical one.
    await applyMigrations(client, listMigrationDirs())

    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES ($1, $2, $3, $4)`,
      [ownerId, 'rollback-owner@example.com', 'test-placeholder', 'Rollback Owner'],
    )
    await client.query(
      `INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
       VALUES ($1, $2, $3, $4, $5)`,
      [workId, 'Rollback Work', 'rollback work', 'uk', ownerId],
    )
    await client.query(`INSERT INTO "Author" (id, name, "nameNorm") VALUES ($1, $2, $3)`, [
      authorId,
      'Rollback Author',
      'rollback author',
    ])
    await client.query(
      `INSERT INTO "CatalogRevision"
         (id, "entityType", "entityId", "actorId", before, after, "fromRevision", "toRevision")
       VALUES ($1, 'WORK', $2, $3, $4, $5, 1, 2)`,
      [
        revisionId,
        workId,
        ownerId,
        JSON.stringify({ title: 'До' }),
        JSON.stringify({ title: 'Після' }),
      ],
    )
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('§B: an old-app-shaped WorkAuthor/Translation insert (no position/createdById) fails on the required migration', async () => {
    await expect(
      client.query(
        `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, 'AUTHOR')`,
        [workId, authorId],
      ),
    ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION })

    await expect(
      client.query(
        `INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang") VALUES ($1, $2, $3, $4, $5)`,
        ['rollback-translation-1', workId, 'Перекладач', 'uk', 'en'],
      ),
    ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION })
  })

  it('§A: the documented undo-NOT-NULL migration applies cleanly and restores old-app write compatibility', async () => {
    await expect(client.query(UNDO_NOT_NULL_SQL)).resolves.toBeDefined()

    // The exact inserts that failed above now succeed — this is what makes
    // rolling the app back to pre-8e-1 code safe again.
    await expect(
      client.query(
        `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, 'AUTHOR')`,
        [workId, authorId],
      ),
    ).resolves.toBeDefined()

    await expect(
      client.query(
        `INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang") VALUES ($1, $2, $3, $4, $5)`,
        ['rollback-translation-1', workId, 'Перекладач', 'uk', 'en'],
      ),
    ).resolves.toBeDefined()
  })

  it('§A loses nothing: pre-existing Work data and the CatalogRevision audit row survive untouched', async () => {
    const work = await client.query<{ title: string; revision: number }>(
      `SELECT title, revision FROM "Work" WHERE id = $1`,
      [workId],
    )

    expect(work.rows[0]).toEqual({ title: 'Rollback Work', revision: 1 })

    const revision = await client.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM "CatalogRevision" WHERE id = $1`,
      [revisionId],
    )

    expect(revision.rows[0]).toEqual({
      before: { title: 'До' },
      after: { title: 'Після' },
    })
  })
})
