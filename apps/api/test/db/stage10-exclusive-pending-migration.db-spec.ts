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
 * Stage 10, крок 10e (docs/plan/stage-10-real-world-history.md, §6.13, M5a/M5, MIG3, C1): дві міграції
 * як ОНОВЛЕННЯ наповненої БД —
 *
 * - M5a `stage10_record_notification_types`: нові значення `NotificationType` (окремо від M5);
 * - M5 `stage10_exclusive_pending`: `one_active_loan_per_copy` розширено до `PENDING_CONFIRMATION`.
 *
 * Жоден наявний `Copy`/`Loan`/`LoanEvent`/`Notification` не змінюється й не втрачається.
 */
const M5A = '20260926110000_stage10_record_notification_types'
const M5 = '20260926110100_stage10_exclusive_pending'
const INDEX = 'one_active_loan_per_copy'
const NEW_TYPES = [
  'LOAN_RECORD_PROPOSED',
  'LOAN_RECORD_CONFIRMED',
  'LOAN_RECORD_DECLINED',
  'LOAN_RECORD_WITHDRAWN',
  'LOAN_RECORD_AMENDED',
]

describe('Stage 10 (10e): M5a + M5 upgrade a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: Record<string, unknown[]>
  const TABLES = ['Copy', 'Loan', 'LoanEvent', 'Notification', 'NotificationDelivery', 'User']

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {}

    for (const table of TABLES) {
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
      )

      result[table] = rows.map((row) => row.row)
    }

    return result
  }

  const insertLoan = (id: string, copyId: string, status: string): Promise<unknown> =>
    client.query(
      `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt")
       VALUES ($1, $2, 'u-owner', 'u-friend', $3::"LoanStatus", now())`,
      [id, copyId, status],
    )

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10exclusive')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M5A)

    if (index === -1) throw new Error(`Migration folder not found: ${M5A}`)

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
        ('c-res', 'e-1', 'u-owner', 'u-owner', 'RESERVED'),
        ('c-out', 'e-1', 'u-owner', 'u-friend', 'LENT_OUT'),
        ('c-lost', 'e-1', 'u-owner', 'u-friend', 'UNAVAILABLE'),
        ('c-new', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-new2', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt", "returnedAt") VALUES
        ('l-req', 'c-home', 'u-owner', 'u-friend', 'REQUESTED', NULL, NULL),
        ('l-rej', 'c-home', 'u-owner', 'u-friend', 'REJECTED', NULL, NULL),
        ('l-res', 'c-res', 'u-owner', 'u-friend', 'APPROVED', NULL, NULL),
        ('l-out', 'c-out', 'u-owner', 'u-friend', 'HANDED_OVER', now(), NULL),
        ('l-ret', 'c-home', 'u-owner', 'u-friend', 'RETURNED', now() - interval '9 days', now() - interval '2 days'),
        ('l-lost', 'c-lost', 'u-owner', 'u-friend', 'LOST', now() - interval '20 days', NULL);
      INSERT INTO "Notification" (id, "userId", type, payload) VALUES
        ('n-1', 'u-owner', 'LOAN_REQUESTED', '{"loanId":"l-req"}'),
        ('n-2', 'u-friend', 'LOAN_APPROVED', '{"loanId":"l-res"}'),
        ('n-3', 'u-friend', 'FRIEND_ACCEPTED', '{}');
    `)

    before = await snapshot()

    await applyMigration(client, M5A)
    await applyMigration(client, M5)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('MIG1: жоден наявний Copy/Loan/LoanEvent/Notification не змінено й не втрачено', async () => {
    expect(before.Copy).toHaveLength(6)
    expect(before.Loan).toHaveLength(6)
    expect(before.Notification).toHaveLength(3)
    expect(await snapshot()).toEqual(before)
  })

  it('M5a: усі п’ять нових значень NotificationType існують, старі не зникли', async () => {
    const { rows } = await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'NotificationType'`,
    )
    const labels = rows.map((row) => row.label)

    for (const type of [...NEW_TYPES, 'LOAN_REQUESTED', 'LOAN_CANCELLED', 'FRIEND_ACCEPTED']) {
      expect(labels).toContain(type)
    }
  })

  it('M5a: нові типи можна записати (нове значення enum використовується вже після коміту міграції)', async () => {
    for (const [index, type] of NEW_TYPES.entries()) {
      await client.query(
        `INSERT INTO "Notification" (id, "userId", type, payload)
         VALUES ($1, 'u-owner', $2::"NotificationType", '{}')`,
        [`n-new-${String(index)}`, type],
      )
    }
  })

  it('MIG3: індекс частковий, унікальний і включає PENDING_CONFIRMATION; REQUESTED — ні', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
      [INDEX],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0]?.indexdef).toMatch(/APPROVED/)
    expect(rows[0]?.indexdef).toMatch(/HANDED_OVER/)
    expect(rows[0]?.indexdef).toMatch(/PENDING_CONFIRMATION/)
    expect(rows[0]?.indexdef).not.toMatch(/REQUESTED/)
  })

  it('C1/MIG3: два PENDING_CONFIRMATION на один примірник порушують індекс', async () => {
    await insertLoan('l-p1', 'c-new', 'PENDING_CONFIRMATION')

    await expect(insertLoan('l-p2', 'c-new', 'PENDING_CONFIRMATION')).rejects.toMatchObject({
      code: '23505',
      constraint: INDEX,
    })
  })

  it('MIG3: PENDING_CONFIRMATION не співіснує з APPROVED/HANDED_OVER на тому самому примірнику', async () => {
    await expect(insertLoan('l-p3', 'c-new', 'APPROVED')).rejects.toMatchObject({ code: '23505' })
    await expect(insertLoan('l-p4', 'c-new', 'HANDED_OVER')).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('REQUESTED, DECLINED, CANCELLED і термінальні з PENDING_CONFIRMATION співіснують', async () => {
    for (const [index, status] of [
      'REQUESTED',
      'REQUESTED',
      'DECLINED',
      'CANCELLED',
      'REJECTED',
      'RETURNED',
      'LOST',
    ].entries()) {
      await insertLoan(`l-ok-${String(index)}`, 'c-new', status)
    }
  })

  it('PENDING_CONFIRMATION дозволено на примірнику без ексклюзивної позики', async () => {
    await insertLoan('l-p5', 'c-new2', 'PENDING_CONFIRMATION')
  })
})
