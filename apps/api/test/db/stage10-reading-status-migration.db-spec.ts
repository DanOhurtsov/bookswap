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
 * Stage 10, крок 10j.1 (docs/plan/stage-10-real-world-history.md, §6.15 T11/T16, §9.7 RS12, M7):
 * enum `ReadingStatus` і порожня таблиця `WorkReadingStatus`, застосовані до наповненої БД. Міграція лише
 * додає: жоден наявний рядок жодної таблиці не змінюється, `Loan` не породжує `READ`, backfill немає.
 */
const M7 = '20260930090000_stage10_reading_status'

describe('Stage 10 (10j.1): stage10_reading_status upgrades a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let tables: string[]
  let before: Record<string, unknown[]>

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {}

    for (const table of tables) {
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )

      result[table] = rows.map((r) => r.row)
    }

    return result
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10readst')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M7)

    if (index === -1) throw new Error(`Migration folder not found: ${M7}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-reader', 'reader@example.com', 'test-placeholder', 'Читач');
      INSERT INTO "ExternalBorrower" (id, "ownerId", alias) VALUES ('eb-1', 'u-owner', 'Гість');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById") VALUES
        ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner'),
        ('w-2', 'Дублікат', 'дублікат', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById") VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", "heldByContactId", status) VALUES
        ('c-1', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE'),
        ('c-2', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE'),
        ('c-guest', 'e-1', 'u-owner', NULL, 'eb-1', 'UNAVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt") VALUES
        ('l-returned', 'c-1', 'u-owner', 'u-reader', 'RETURNED', now() - interval '20 days'),
        ('l-requested', 'c-2', 'u-owner', 'u-reader', 'REQUESTED', NULL);
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerKind", origin, "borrowerContactId", status, "requestedAt", "handedAt") VALUES
        ('l-guest', 'c-guest', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-1', 'LOST', NULL, now() - interval '30 days');
      INSERT INTO "WishlistItem" (id, "userId", "workId") VALUES ('wi-1', 'u-reader', 'w-1');
    `)

    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
    )

    tables = rows.map((row) => row.tablename)
    before = await snapshot()

    await applyMigration(client, M7)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('до M7 таблиці немає й наповнено дані, включно з позиками (у тому числі гостьовою)', () => {
    expect(tables).not.toContain('WorkReadingStatus')
    expect(before['Loan']).toHaveLength(3)
    expect(before['User']).toHaveLength(2)
  })

  it('жоден наявний рядок жодної таблиці не змінився (кількість і вміст)', async () => {
    const after = await snapshot()

    expect(after).toEqual(before)
  })

  it('нова таблиця порожня: backfill із Loan відсутній, READ не виведено', async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM "WorkReadingStatus"`,
    )

    expect(rows[0]?.count).toBe('0')
  })

  it('enum ReadingStatus містить NOT_READ, READING, READ у цьому порядку', async () => {
    const { rows } = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ReadingStatus' ORDER BY e.enumsortorder`,
    )

    expect(rows.map((row) => row.enumlabel)).toEqual(['NOT_READ', 'READING', 'READ'])
  })

  it('UNIQUE (userId, workId) діє на рівні БД; інший користувач чи Work — окремий рядок', async () => {
    const insert = (
      id: string,
      userId: string,
      workId: string,
      status = 'READ',
    ): Promise<unknown> =>
      client.query(
        `INSERT INTO "WorkReadingStatus" (id, "userId", "workId", status, "updatedAt")
         VALUES ($1, $2, $3, $4::"ReadingStatus", now())`,
        [id, userId, workId, status],
      )

    await insert('rs-1', 'u-reader', 'w-1')

    await expect(insert('rs-dup', 'u-reader', 'w-1', 'READING')).rejects.toMatchObject({
      code: '23505',
      constraint: 'WorkReadingStatus_userId_workId_key',
    })
    await expect(insert('rs-2', 'u-owner', 'w-1')).resolves.toBeDefined()
    await expect(insert('rs-3', 'u-reader', 'w-2', 'NOT_READ')).resolves.toBeDefined()
  })

  it('невідомий статус відхиляється enum-ом', async () => {
    await expect(
      client.query(
        `INSERT INTO "WorkReadingStatus" (id, "userId", "workId", status, "updatedAt")
         VALUES ('rs-bad', 'u-owner', 'w-2', 'DONE', now())`,
      ),
    ).rejects.toMatchObject({ code: '22P02' })
  })

  it('зовнішні ключі: Work — RESTRICT, User — CASCADE', async () => {
    const { rows } = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = '"WorkReadingStatus"'::regclass AND contype = 'f' ORDER BY conname`,
    )

    expect(rows).toEqual([
      { conname: 'WorkReadingStatus_userId_fkey', confdeltype: 'c' },
      { conname: 'WorkReadingStatus_workId_fkey', confdeltype: 'r' },
    ])

    await expect(client.query(`DELETE FROM "Work" WHERE id = 'w-1'`)).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('немає зв’язків із Copy/Loan/ExternalBorrower (R-2, R-9): колонки лише власні', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'WorkReadingStatus' ORDER BY column_name`,
    )

    expect(rows.map((row) => row.column_name)).toEqual([
      'createdAt',
      'id',
      'status',
      'updatedAt',
      'userId',
      'workId',
    ])
  })
})
