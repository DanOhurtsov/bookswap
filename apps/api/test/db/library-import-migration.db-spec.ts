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
 * Stage 8f-1 (docs/plan/stage-8-inventory.md, §5): the `library_import`
 * migration as an UPGRADE, not only as part of a from-scratch deploy
 * (`global-setup.ts`). On a disposable scratch database: every earlier real
 * migration, synthetic production-shaped data across the whole catalog/loan
 * graph, then this migration's real `migration.sql` — and nothing that existed
 * before may change.
 */
const MIGRATION = '20260917120000_library_import'

/** Tables whose rows must survive the upgrade byte-for-byte. */
const PRESERVED_TABLES = [
  'User',
  'Friendship',
  'Author',
  'Work',
  'WorkAuthor',
  'Translation',
  'Edition',
  'Copy',
  'Loan',
  'WishlistItem',
  'ProductEvent',
  'CatalogRevision',
] as const

const SHA256_HEX = 'a'.repeat(64)

describe('Stage 8f-1: library_import migration upgrades a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {}

    for (const table of PRESERVED_TABLES) {
      // Identifiers come from the constant list above, never from input.
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
      result[table] = rows.map((entry) => entry.row)
    }

    return result
  }

  let before: Record<string, unknown[]>

  beforeAll(async () => {
    scratch = await createScratchDatabase('library_import')
    client = scratch.client

    // Located by exact name, not by being last: later migrations must not
    // change what this historical upgrade replays.
    const dirs = listMigrationDirs()
    const index = dirs.indexOf(MIGRATION)

    if (index === -1) throw new Error(`Migration folder not found: ${MIGRATION}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-borrower', 'borrower@example.com', 'test-placeholder', 'Позичальник');
      INSERT INTO "Friendship" (id, "userAId", "userBId", "requestedById", status)
        VALUES ('f-1', 'u-borrower', 'u-owner', 'u-owner', 'ACCEPTED');
      INSERT INTO "Author" (id, name, "nameNorm") VALUES ('a-1', 'Леся Українка', 'леся українка');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "WorkAuthor" ("workId", "authorId", role, position) VALUES ('w-1', 'a-1', 'AUTHOR', 0);
      INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang", "createdById")
        VALUES ('t-1', 'w-1', 'Перекладач', 'en', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", "translationId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', 't-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", note)
        VALUES ('c-1', 'e-1', 'u-owner', 'u-owner', 'приватна нотатка');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status)
        VALUES ('l-1', 'c-1', 'u-owner', 'u-borrower', 'RETURNED');
      INSERT INTO "WishlistItem" (id, "userId", "workId") VALUES ('wi-1', 'u-borrower', 'w-1');
      INSERT INTO "ProductEvent" (id, type, properties, "dedupeKey", "subjectUserId")
        VALUES ('pe-1', 'BOOK_ADDED', '{"method":"MANUAL"}', 'dedupe-1', 'u-owner');
      INSERT INTO "CatalogRevision" (id, "entityType", "entityId", "actorId", before, after, "fromRevision", "toRevision")
        VALUES ('cr-1', 'WORK', 'w-1', 'u-owner', '{"title":"До"}', '{"title":"Після"}', 1, 2);
    `)

    before = await snapshot()

    await applyMigration(client, MIGRATION)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('every pre-existing row in every table survives unchanged', async () => {
    for (const table of PRESERVED_TABLES) {
      expect(before[table]).not.toHaveLength(0)
    }

    expect(await snapshot()).toEqual(before)
  })

  it('the new tables start empty and accept a draft linked to an existing user', async () => {
    const { rows: empty } = await client.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM "LibraryImport") + (SELECT count(*) FROM "LibraryImportRow") AS count`,
    )

    expect(empty[0]?.count).toBe('0')

    await client.query(
      `INSERT INTO "LibraryImport" (id, "ownerId", "sourceHash", "rowCount", "copyCount", "expiresAt", "updatedAt")
       VALUES ('li-1', 'u-owner', $1, 1, 1, now() + interval '24 hours', now())`,
      [SHA256_HEX],
    )
    await client.query(
      `INSERT INTO "LibraryImportRow" ("importId", "rowNumber", status, payload)
       VALUES ('li-1', 1, 'NEEDS_REVIEW', '{}')`,
    )

    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM "LibraryImport" WHERE id = 'li-1'`,
    )

    expect(rows[0]?.status).toBe('DRAFT')
  })

  it('deleting a user cascades to their own imports and rows only', async () => {
    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "displayName")
       VALUES ('u-importer', 'importer@example.com', 'test-placeholder', 'Імпортер')`,
    )
    await client.query(
      `INSERT INTO "LibraryImport" (id, "ownerId", "sourceHash", "rowCount", "copyCount", "expiresAt", "updatedAt")
       VALUES ('li-2', 'u-importer', $1, 1, 1, now() + interval '24 hours', now())`,
      [SHA256_HEX],
    )
    await client.query(
      `INSERT INTO "LibraryImportRow" ("importId", "rowNumber", status, payload)
       VALUES ('li-2', 1, 'SKIPPED', '{}')`,
    )

    await client.query(`DELETE FROM "User" WHERE id = 'u-importer'`)

    const { rows } = await client.query<{ id: string }>(
      `SELECT "importId" AS id FROM "LibraryImportRow"
       UNION ALL SELECT id FROM "LibraryImport" ORDER BY id`,
    )

    expect(rows.map((row) => row.id)).toEqual(['li-1', 'li-1'])
  })
})
