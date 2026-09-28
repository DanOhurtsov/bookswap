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
 * Stage 10, крок 10f.3 (docs/plan/stage-10-real-world-history.md, §6.11.1, T7b-1, §6.13, M8a/M8b):
 * нове значення enum `LoanEventType.LOSS_CLOSED` (M8a) і частковий
 * `UNIQUE (loanId) WHERE type = 'LOSS_CLOSED'` на `LoanEvent` (M8b) — точна калька M4, застосована
 * до наповненої БД. Обидві міграції лише додають; жоден наявний `Copy`/`Loan`/`LoanEvent` не
 * змінюється.
 */
const M8A = '20260927130000_stage10_loss_closed_enum'
const M8B = '20260927130100_stage10_loss_closure_unique'
const INDEX = 'one_loss_closure_per_loan'

describe('Stage 10 (10f.3): stage10_loss_closed_enum + stage10_loss_closure_unique upgrade a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: { copies: unknown[]; loans: unknown[]; events: unknown[] }

  async function snapshot(): Promise<typeof before> {
    const copies = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "Copy" t ORDER BY id`,
    )
    const loans = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "Loan" t ORDER BY id`,
    )
    const events = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "LoanEvent" t ORDER BY id`,
    )

    return {
      copies: copies.rows.map((r) => r.row),
      loans: loans.rows.map((r) => r.row),
      events: events.rows.map((r) => r.row),
    }
  }

  const insertEvent = (id: string, loanId: string, type: string): Promise<unknown> =>
    client.query(
      `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ($1, $2, $3::"LoanEventType")`,
      [id, loanId, type],
    )

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10lclosed')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M8A)

    if (index === -1) throw new Error(`Migration folder not found: ${M8A}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця');
      INSERT INTO "ExternalBorrower" (id, "ownerId", alias) VALUES
        ('eb-1', 'u-owner', 'Гість');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", "heldByContactId", status) VALUES
        ('c-lost', 'e-1', 'u-owner', NULL, 'eb-1', 'UNAVAILABLE'),
        ('c-lost2', 'e-1', 'u-owner', NULL, 'eb-1', 'UNAVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerKind", origin, "borrowerContactId", status, "requestedAt", "handedAt") VALUES
        ('l-lost', 'c-lost', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-1', 'LOST', NULL, now() - interval '20 days'),
        ('l-lost2', 'c-lost2', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-1', 'LOST', NULL, now() - interval '30 days');
    `)

    before = await snapshot()

    // M8a — окрема транзакція (нове значення enum не можна вжити в тій самій, де воно додане).
    await applyMigration(client, M8A)
    await applyMigration(client, M8B)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('M8a+M8b не змінюють і не видаляють жодного наявного Copy/Loan/LoanEvent', async () => {
    expect(before.copies).toHaveLength(2)
    expect(before.loans).toHaveLength(2)
    expect(before.events).toHaveLength(0)
    expect(await snapshot()).toEqual(before)
  })

  it('нове значення enum LOSS_CLOSED використовується без помилки', async () => {
    await expect(
      insertEvent('ev-loss-closed-usable', 'l-lost', 'LOSS_CLOSED'),
    ).resolves.toBeDefined()
  })

  it('індекс частковий і унікальний: лише type = LOSS_CLOSED', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
      [INDEX],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0]?.indexdef).toMatch(/WHERE/)
    expect(rows[0]?.indexdef).toMatch(/LOSS_CLOSED/)
  })

  it('друга LOSS_CLOSED для тієї самої позики порушує індекс', async () => {
    await expect(insertEvent('ev-loss-closed-dup', 'l-lost', 'LOSS_CLOSED')).rejects.toMatchObject({
      code: '23505',
      constraint: INDEX,
    })
  })

  it('RECOVERED і LOSS_CLOSED для тієї самої позики можуть співіснувати (Q3c) — окремі індекси', async () => {
    await expect(insertEvent('ev-recovered-coexist', 'l-lost', 'RECOVERED')).resolves.toBeDefined()

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM "LoanEvent" WHERE "loanId" = 'l-lost'`,
    )

    expect(rows[0]?.count).toBe('2')
  })

  it('LOSS_CLOSED іншої позики індекс не зачіпає', async () => {
    await expect(insertEvent('ev-lost2-closed', 'l-lost2', 'LOSS_CLOSED')).resolves.toBeDefined()
  })
})
