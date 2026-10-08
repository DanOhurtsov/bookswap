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
 * Stage 10, крок 10d (docs/plan/stage-10-real-world-history.md, §6.13, M4, REC2, REC5): частковий
 * `UNIQUE (loanId) WHERE type = 'RECOVERED'` на `LoanEvent` як ОНОВЛЕННЯ наповненої БД.
 *
 * Міграція лише додає індекс: жоден наявний `Copy`/`Loan` не змінюється, подій вона не створює, а
 * старі `LOST`-позики лишаються без подій.
 */
const M4 = '20260926100000_stage10_recovered_unique'
const INDEX = 'one_recovery_per_loan'

describe('Stage 10 (10d): stage10_recovered_unique upgrades a populated database', () => {
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

  const insertEvent = (id: string, loanId: string, type: string): Promise<unknown> =>
    client.query(
      `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ($1, $2, $3::"LoanEventType")`,
      [id, loanId, type],
    )

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10recovered')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M4)

    if (index === -1) throw new Error(`Migration folder not found: ${M4}`)

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
        ('c-home', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-out', 'e-1', 'u-owner', 'u-friend', 'LENT_OUT'),
        ('c-lost', 'e-1', 'u-owner', 'u-friend', 'UNAVAILABLE'),
        ('c-lost2', 'e-1', 'u-owner', 'u-friend', 'UNAVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt", "returnedAt") VALUES
        ('l-ret', 'c-home', 'u-owner', 'u-friend', 'RETURNED', now() - interval '9 days', now() - interval '2 days'),
        ('l-out', 'c-out', 'u-owner', 'u-friend', 'HANDED_OVER', now(), NULL),
        ('l-lost', 'c-lost', 'u-owner', 'u-friend', 'LOST', now() - interval '20 days', NULL),
        ('l-lost2', 'c-lost2', 'u-owner', 'u-friend', 'LOST', now() - interval '30 days', NULL);
    `)

    before = await snapshot()

    await applyMigration(client, M4)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('REC5: M4 не змінює й не видаляє жодного наявного Copy/Loan', async () => {
    expect(before.copies).toHaveLength(4)
    expect(before.loans).toHaveLength(4)
    expect(await snapshot()).toEqual(before)
  })

  it('REC5: M4 не створює подій — старі LOST-позики лишаються без LoanEvent', async () => {
    const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM "LoanEvent"`)

    expect(rows[0]?.count).toBe('0')
  })

  it('індекс частковий і унікальний: лише type = RECOVERED', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
      [INDEX],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0]?.indexdef).toMatch(/WHERE/)
    expect(rows[0]?.indexdef).toMatch(/RECOVERED/)
  })

  it('REC2: друга RECOVERED для тієї самої позики порушує індекс', async () => {
    await insertEvent('ev-1', 'l-lost', 'RECOVERED')

    await expect(insertEvent('ev-2', 'l-lost', 'RECOVERED')).rejects.toMatchObject({
      code: '23505',
      constraint: INDEX,
    })
  })

  it('інші типи подій тієї ж позики, а також RECOVERED інших позик індекс не зачіпає', async () => {
    await insertEvent('ev-3', 'l-lost', 'LOAN_LOST')
    await insertEvent('ev-4', 'l-lost', 'LOAN_LOST')
    await insertEvent('ev-5', 'l-lost2', 'RECOVERED')

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM "LoanEvent" WHERE type = 'RECOVERED'`,
    )

    expect(rows[0]?.count).toBe('2')
  })

  it('події не змінили жодного Copy/Loan', async () => {
    expect(await snapshot()).toEqual(before)
  })
})
