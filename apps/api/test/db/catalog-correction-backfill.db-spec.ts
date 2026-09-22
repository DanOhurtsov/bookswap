import type { Client } from 'pg'
import {
  applyMigration,
  applyMigrations,
  createScratchDatabase,
  SCRATCH_CLEANUP_TIMEOUT_MS,
  listMigrationDirs,
  type ScratchDatabase,
} from './migration-scratch'

/**
 * Stage 8e-1 (docs/plan/stage-8-inventory.md, §5/R10a). Every other
 * `*.db-spec.ts` file runs against a database that already has every
 * migration applied (`global-setup.ts`) — a fine way to check the final
 * shape, but it never proves the migration SEQUENCE itself is safe against
 * real pre-existing data. This file does: it replays the actual
 * `migration.sql` files, unmodified, on a disposable scratch database (see
 * `migration-scratch.ts`) — old schema, legacy rows shaped exactly as the
 * pre-migration schema allowed, the additive/backfill migration, then the
 * required one — and checks the backfill against the same rule the
 * application uses in JS (`localeCompare(..., 'uk')`), not a second,
 * possibly-drifted copy of it.
 */
const SCHEMA_MIGRATION = '20260910231627_catalog_correction_audit_schema'
const REQUIRED_MIGRATION = '20260910231806_catalog_correction_audit_required'

interface LegacyAuthor {
  id: string
  name: string
  role: 'AUTHOR' | 'CO_AUTHOR' | 'EDITOR' | 'ILLUSTRATOR'
}

describe('Stage 8e-1: real migration files replayed on a scratch DB (legacy data → additive/backfill → required)', () => {
  let scratch: ScratchDatabase
  let client: Client

  const ownerId = 'legacy-owner'
  const workId = 'legacy-work-1'
  const translationId = 'legacy-translation-1'
  const editionId = 'legacy-edition-1'

  // Namesakes (`author-ivan-a`/`-b`) exercise the authorId tie-break; the
  // Григорій/Євген pair exercises `COLLATE "uk-x-icu"` specifically — Ukrainian
  // alphabetical order puts Г before Є, but Unicode codepoint order does not
  // (Є is U+0404, below Г's U+0413), so a naive default-collation sort would
  // get this pair backwards.
  const authors: LegacyAuthor[] = [
    { id: 'author-hryhorii', name: 'Григорій Сковорода', role: 'AUTHOR' },
    { id: 'author-yevhen', name: 'Євген Гуцало', role: 'AUTHOR' },
    { id: 'author-ivan-a', name: 'Іван Франко', role: 'AUTHOR' },
    { id: 'author-ivan-b', name: 'Іван Франко', role: 'AUTHOR' },
    { id: 'author-oksana', name: 'Оксана Забужко', role: 'CO_AUTHOR' },
    { id: 'author-lesia', name: 'Леся Українка', role: 'EDITOR' },
    { id: 'author-yurii', name: 'Юрій Винничук', role: 'ILLUSTRATOR' },
  ]

  // Bracketed with the database's own clock (`SELECT NOW()`), not Node's:
  // the scratch DB can run in a different container than the test process,
  // and comparing `Date.now()` against Postgres's `CURRENT_TIMESTAMP` across
  // that boundary is exactly the kind of cross-clock comparison that a
  // hypervisor clock skew (observed here under WSL2) makes flaky for no
  // reason connected to the backfill itself.
  let beforeAdditiveMigration: Date
  let afterAdditiveMigration: Date

  async function dbNow(): Promise<Date> {
    // `LOCALTIMESTAMP`, not `NOW()`: `"createdAt"` is `timestamp(3)` WITHOUT
    // time zone, same as the migration's `DEFAULT CURRENT_TIMESTAMP`. node-pg
    // parses a tz-less `timestamp` by assuming it's already in the process's
    // local zone, but parses `NOW()`'s `timestamptz` correctly with its real
    // offset — mixing the two produced a phantom multi-hour gap in this WSL2
    // container setup that had nothing to do with the backfill. Reading both
    // sides through the tz-less type makes any such systematic misparse cancel
    // out instead of leaking into the comparison.
    const { rows } = await client.query<{ now: Date }>('SELECT LOCALTIMESTAMP(3) AS now')

    if (rows[0] === undefined) throw new Error('SELECT LOCALTIMESTAMP returned no row')

    return rows[0].now
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('backfill')
    client = scratch.client

    const dirs = listMigrationDirs()
    const cutoff = dirs.indexOf(SCHEMA_MIGRATION)

    if (cutoff === -1) throw new Error(`Migration folder not found: ${SCHEMA_MIGRATION}`)
    if (dirs[cutoff + 1] !== REQUIRED_MIGRATION) {
      throw new Error(`Expected ${REQUIRED_MIGRATION} directly after ${SCHEMA_MIGRATION}`)
    }

    // 1. Old schema: every real migration file up to (not including) the
    //    additive one — the exact state production was in before this stage.
    await applyMigrations(client, dirs.slice(0, cutoff))

    // 2. Legacy data, shaped exactly as the pre-migration schema allowed: no
    //    Work/Translation/Edition.revision, no Translation.createdById/createdAt,
    //    no WorkAuthor.position — those columns don't exist yet at this point.
    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES ($1, $2, $3, $4)`,
      [ownerId, 'legacy-owner@example.com', 'test-placeholder', 'Legacy Owner'],
    )

    await client.query(
      `INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
       VALUES ($1, $2, $3, $4, $5)`,
      [workId, 'Legacy Work', 'legacy work', 'uk', ownerId],
    )

    for (const author of authors) {
      await client.query(`INSERT INTO "Author" (id, name, "nameNorm") VALUES ($1, $2, $3)`, [
        author.id,
        author.name,
        author.name.toLowerCase(),
      ])
      await client.query(
        `INSERT INTO "WorkAuthor" ("workId", "authorId", role) VALUES ($1, $2, $3::"AuthorRole")`,
        [workId, author.id, author.role],
      )
    }

    await client.query(
      `INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang")
       VALUES ($1, $2, $3, $4, $5)`,
      [translationId, workId, 'Legacy Translator', 'en', 'uk'],
    )

    await client.query(`INSERT INTO "Edition" (id, "workId", "createdById") VALUES ($1, $2, $3)`, [
      editionId,
      workId,
      ownerId,
    ])

    // 3. The additive migration: schema change and backfill, one real file,
    //    exactly as it will run in production.
    beforeAdditiveMigration = await dbNow()
    await applyMigration(client, SCHEMA_MIGRATION)
    afterAdditiveMigration = await dbNow()
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('Translation.createdById backfills from the parent Work.createdById', async () => {
    const { rows } = await client.query<{ createdById: string }>(
      `SELECT "createdById" FROM "Translation" WHERE id = $1`,
      [translationId],
    )

    expect(rows[0]?.createdById).toBe(ownerId)
  })

  it('Translation.createdAt backfills to migration time, not an invented historical date', async () => {
    const { rows } = await client.query<{ createdAt: Date }>(
      `SELECT "createdAt" FROM "Translation" WHERE id = $1`,
      [translationId],
    )
    const createdAt = rows[0]?.createdAt

    expect(createdAt).toBeInstanceOf(Date)
    expect((createdAt as Date).getTime()).toBeGreaterThanOrEqual(beforeAdditiveMigration.getTime())
    expect((createdAt as Date).getTime()).toBeLessThanOrEqual(afterAdditiveMigration.getTime())
  })

  it('Work/Translation/Edition.revision backfill to 1 for pre-existing rows', async () => {
    // Sequential, not `Promise.all`: `pg.Client` queues concurrent queries on
    // one connection today but deprecates doing so (pg@9 removes it) — a
    // single connection is exactly right for a small scratch-DB check, so
    // await each query instead of relying on that queueing.
    const work = await client.query<{ revision: number }>(
      `SELECT revision FROM "Work" WHERE id = $1`,
      [workId],
    )
    const translation = await client.query<{ revision: number }>(
      `SELECT revision FROM "Translation" WHERE id = $1`,
      [translationId],
    )
    const edition = await client.query<{ revision: number }>(
      `SELECT revision FROM "Edition" WHERE id = $1`,
      [editionId],
    )

    expect(work.rows[0]?.revision).toBe(1)
    expect(translation.rows[0]?.revision).toBe(1)
    expect(edition.rows[0]?.revision).toBe(1)
  })

  it('WorkAuthor.position backfills gapless 0..n-1: role, then name via localeCompare("uk"), then authorId', async () => {
    const { rows } = await client.query<{ authorId: string; role: string; position: number }>(
      `SELECT "authorId", role, position FROM "WorkAuthor" WHERE "workId" = $1 ORDER BY position`,
      [workId],
    )

    expect(rows).toHaveLength(authors.length)
    // Gapless 0..n-1, independent of what order backfill actually computed.
    expect(rows.map((row) => row.position)).toEqual(authors.map((_, index) => index))

    const ROLE_ORDER = ['AUTHOR', 'CO_AUTHOR', 'EDITOR', 'ILLUSTRATOR']

    // The same rule R10a requires of the backfill SQL, computed independently
    // in JS — not a hand-picked expected sequence.
    const expectedOrder = [...authors]
      .sort((one, other) => {
        const roleDiff = ROLE_ORDER.indexOf(one.role) - ROLE_ORDER.indexOf(other.role)

        if (roleDiff !== 0) return roleDiff

        return one.name.localeCompare(other.name, 'uk') || one.id.localeCompare(other.id)
      })
      .map((author) => author.id)

    expect(rows.map((row) => row.authorId)).toEqual(expectedOrder)

    // The namesake pair specifically: identical name, tie broken by authorId.
    const ivanA = rows.find((row) => row.authorId === 'author-ivan-a')
    const ivanB = rows.find((row) => row.authorId === 'author-ivan-b')

    expect(ivanA?.position).toBeLessThan(ivanB?.position ?? Number.POSITIVE_INFINITY)

    // Ukrainian alphabetical order (Г before Є) diverges from Unicode codepoint
    // order (Є < Г) — this is exactly why the migration COLLATEs by
    // "uk-x-icu" instead of the database's default collation.
    const hryhorii = rows.find((row) => row.authorId === 'author-hryhorii')
    const yevhen = rows.find((row) => row.authorId === 'author-yevhen')

    expect(hryhorii?.position).toBeLessThan(yevhen?.position ?? Number.POSITIVE_INFINITY)
    expect('Григорій Сковорода'.localeCompare('Євген Гуцало', 'uk')).toBeLessThan(0)
  })

  it('the required migration then succeeds — backfill left no NULLs behind', async () => {
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
})
