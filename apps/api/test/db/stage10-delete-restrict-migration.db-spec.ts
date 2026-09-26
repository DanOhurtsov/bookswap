import type { Client } from 'pg'
import {
  applyMigration,
  applyMigrations,
  createScratchDatabase,
  listMigrationDirs,
  SCRATCH_CLEANUP_TIMEOUT_MS,
  type ScratchDatabase,
} from './migration-scratch'

/**
 * Stage 10, крок 10c (docs/plan/stage-10-real-world-history.md, §6.13, M3, DEL4): `Loan_copyId_fkey`
 * `CASCADE → RESTRICT` як ОНОВЛЕННЯ наповненої БД. Міграція змінює лише правило на майбутнє:
 * жоден наявний `Copy`/`Loan` не змінюється, а після неї `Copy` з будь-яким `Loan` не видалити.
 */
const M3 = '20260926090200_stage10_delete_restrict'

describe('Stage 10 (10c): stage10_delete_restrict upgrades a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: { copies: unknown[]; loans: unknown[] }

  async function snapshot(): Promise<typeof before> {
    const copies = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "Copy" t ORDER BY id`,
    )
    const loans = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "Loan" t ORDER BY id`,
    )

    return { copies: copies.rows.map((r) => r.row), loans: loans.rows.map((r) => r.row) }
  }

  async function deleteRule(): Promise<string> {
    const { rows } = await client.query<{ rule: string }>(
      `SELECT confdeltype::text AS rule FROM pg_constraint WHERE conname = 'Loan_copyId_fkey'`,
    )

    return rows[0]?.rule ?? ''
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10restrict')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M3)

    if (index === -1) throw new Error(`Migration folder not found: ${M3}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-friend', 'friend@example.com', 'test-placeholder', 'Друг');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", status) VALUES
        ('c-free', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-hist', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-out', 'e-1', 'u-owner', 'u-friend', 'LENT_OUT'),
        ('c-lost', 'e-1', 'u-owner', 'u-friend', 'UNAVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt", "returnedAt") VALUES
        ('l-ret', 'c-hist', 'u-owner', 'u-friend', 'RETURNED', now() - interval '9 days', now() - interval '2 days'),
        ('l-rej', 'c-hist', 'u-owner', 'u-friend', 'REJECTED', NULL, NULL),
        ('l-out', 'c-out', 'u-owner', 'u-friend', 'HANDED_OVER', now(), NULL),
        ('l-lost', 'c-lost', 'u-owner', 'u-friend', 'LOST', now(), NULL);
    `)

    expect(await deleteRule()).toBe('c')

    before = await snapshot()

    await applyMigration(client, M3)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('M3 не змінює й не видаляє жодного наявного Copy/Loan', async () => {
    expect(before.copies).toHaveLength(4)
    expect(before.loans).toHaveLength(4)
    expect(await snapshot()).toEqual(before)
  })

  it('DEL4: правило FK стало RESTRICT (r), а не CASCADE (c)', async () => {
    expect(await deleteRule()).toBe('r')
  })

  it('DEL4: Copy із будь-яким наявним Loan більше не видалити; історія цілa', async () => {
    for (const copyId of ['c-hist', 'c-out', 'c-lost']) {
      await expect(
        client.query(`DELETE FROM "Copy" WHERE id = $1`, [copyId]),
      ).rejects.toMatchObject({ constraint: 'Loan_copyId_fkey' })
    }

    expect(await snapshot()).toEqual(before)
  })

  it('DEL1: Copy без Loan видаляється', async () => {
    await client.query(`DELETE FROM "Copy" WHERE id = 'c-free'`)

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM "Copy" WHERE id = 'c-free'`,
    )

    expect(rows[0]?.count).toBe('0')
  })
})
