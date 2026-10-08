import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * Stage 10, крок 10a (docs/plan/stage-10-real-world-history.md, §6.13, тести MIG1, MIG2, MIG6):
 * `stage10_enums` + `stage10_expand` як ОНОВЛЕННЯ наповненої БД. Міграції лише додають і
 * послаблюють: жоден історичний факт не змінюється, а переписані CHECK-и на `Copy` дають ті самі
 * відповіді для всіх наявних (не гостьових) станів.
 */
const M1 = '20260926090000_stage10_enums'
const M2 = '20260926090100_stage10_expand'

type Status = 'AVAILABLE' | 'RESERVED' | 'LENT_OUT' | 'UNAVAILABLE'
const STATUSES: Status[] = ['AVAILABLE', 'RESERVED', 'LENT_OUT', 'UNAVAILABLE']

/** Три імплікації §5.3.2 у тому вигляді, в якому їх тримала міграція `loan_state_machine`. */
function oldCopyRulesAccept(status: Status, holderIsOwner: boolean): boolean {
  if (status === 'AVAILABLE' && !holderIsOwner) return false
  if (!holderIsOwner && status !== 'LENT_OUT' && status !== 'UNAVAILABLE') return false
  if (status === 'LENT_OUT' && holderIsOwner) return false

  return true
}

describe('Stage 10 (10a): stage10_enums + stage10_expand upgrade a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: { copies: unknown[]; loans: unknown[]; others: Record<string, unknown[]> }
  let seq = 0

  const next = (prefix: string): string => `${prefix}-${String(++seq)}`

  async function snapshot(): Promise<typeof before> {
    const copies = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) - ARRAY['archivedAt','heldByContactId'] AS row FROM "Copy" t ORDER BY id`,
    )
    const loans = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) - ARRAY['borrowerKind','borrowerContactId','origin','createdAt'] AS row FROM "Loan" t ORDER BY id`,
    )
    const others: Record<string, unknown[]> = {}

    for (const table of ['User', 'Friendship', 'Work', 'Edition', 'Notification', 'ProductEvent']) {
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
      others[table] = rows.map((entry) => entry.row)
    }

    return { copies: copies.rows.map((r) => r.row), loans: loans.rows.map((r) => r.row), others }
  }

  async function insertCopy(
    status: Status,
    holder: string | null,
    contact: string | null = null,
  ): Promise<string> {
    const id = next('c')

    await client.query(
      `INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", "heldByContactId", status)
       VALUES ($1, 'e-1', 'u-owner', $2, $3, $4::"CopyStatus")`,
      [id, holder, contact, status],
    )

    return id
  }

  async function insertContact(): Promise<string> {
    const id = next('x')

    await client.query(
      `INSERT INTO "ExternalBorrower" (id, "ownerId", alias) VALUES ($1, 'u-owner', 'тест')`,
      [id],
    )

    return id
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10expand')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M1)

    if (index === -1) throw new Error(`Migration folder not found: ${M1}`)
    if (dirs.indexOf(M2) !== index + 1)
      throw new Error('stage10_expand must directly follow stage10_enums')

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-friend', 'friend@example.com', 'test-placeholder', 'Друг');
      INSERT INTO "Friendship" (id, "userAId", "userBId", "requestedById", status)
        VALUES ('f-1', 'u-friend', 'u-owner', 'u-owner', 'ACCEPTED');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", status, note) VALUES
        ('c-avail', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE', 'вдома'),
        ('c-res', 'e-1', 'u-owner', 'u-owner', 'RESERVED', NULL),
        ('c-out', 'e-1', 'u-owner', 'u-friend', 'LENT_OUT', NULL),
        ('c-lost', 'e-1', 'u-owner', 'u-friend', 'UNAVAILABLE', 'втрачена'),
        ('c-hidden', 'e-1', 'u-owner', 'u-owner', 'UNAVAILABLE', NULL),
        ('c-hist', 'e-1', 'u-owner', 'u-owner', 'AVAILABLE', NULL);
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt", "returnedAt") VALUES
        ('l-req', 'c-avail', 'u-owner', 'u-friend', 'REQUESTED', NULL, NULL),
        ('l-app', 'c-res', 'u-owner', 'u-friend', 'APPROVED', NULL, NULL),
        ('l-out', 'c-out', 'u-owner', 'u-friend', 'HANDED_OVER', now(), NULL),
        ('l-lost', 'c-lost', 'u-owner', 'u-friend', 'LOST', now(), NULL),
        ('l-rej', 'c-hidden', 'u-owner', 'u-friend', 'REJECTED', NULL, NULL),
        ('l-can', 'c-hidden', 'u-owner', 'u-friend', 'CANCELLED', NULL, NULL),
        ('l-ret', 'c-hist', 'u-owner', 'u-friend', 'RETURNED', now() - interval '9 days', now() - interval '2 days');
      INSERT INTO "Notification" (id, "userId", type, payload)
        VALUES ('n-1', 'u-owner', 'LOAN_REQUESTED', '{"loanId":"l-req"}');
      INSERT INTO "ProductEvent" (id, type, properties, "dedupeKey", "subjectUserId")
        VALUES ('pe-1', 'BOOK_ADDED', '{"method":"MANUAL"}', 'dedupe-1', 'u-owner');
    `)

    before = await snapshot()

    await applyMigration(client, M1)
    await applyMigration(client, M2)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  // MIG1
  it('MIG1: кожен наявний Copy/Loan і решта фактів лишилися байт-в-байт, нові таблиці порожні', async () => {
    expect(before.copies).toHaveLength(6)
    expect(before.loans).toHaveLength(7)
    expect(await snapshot()).toEqual(before)

    const { rows } = await client.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM "ExternalBorrower") + (SELECT count(*) FROM "LoanEvent") AS count`,
    )

    expect(rows[0]?.count).toBe('0')
  })

  it('MIG1: нові колонки наповнено безпечними дефолтами, createdAt = requestedAt', async () => {
    const copies = await client.query<{ archivedAt: unknown; heldByContactId: unknown }>(
      `SELECT "archivedAt", "heldByContactId" FROM "Copy"`,
    )

    expect(
      copies.rows.every((row) => row.archivedAt === null && row.heldByContactId === null),
    ).toBe(true)

    const loans = await client.query<{
      borrowerKind: string
      borrowerContactId: string | null
      origin: string
      same: boolean
    }>(
      `SELECT "borrowerKind", "borrowerContactId", origin, ("createdAt" = "requestedAt") AS same FROM "Loan"`,
    )

    expect(loans.rows).toHaveLength(7)
    expect(
      loans.rows.every(
        (row) =>
          row.borrowerKind === 'REGISTERED' &&
          row.borrowerContactId === null &&
          row.origin === 'REQUESTED' &&
          row.same,
      ),
    ).toBe(true)
  })

  it('MIG1: наявний loan-flow не змінено — часткові індекси й CHECK borrower≠owner на місці', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_loan_per_copy'`,
    )

    expect(rows[0]?.indexdef).toMatch(/APPROVED/)
    expect(rows[0]?.indexdef).toMatch(/HANDED_OVER/)
    expect(rows[0]?.indexdef).not.toMatch(/PENDING_CONFIRMATION/)

    await expect(
      client.query(
        `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status)
         VALUES ('l-self', 'c-hist', 'u-owner', 'u-owner', 'REQUESTED')`,
      ),
    ).rejects.toMatchObject({ constraint: 'loan_borrower_not_owner' })
  })

  // MIG2
  it('MIG2: для не гостьових станів переписані CHECK-и дають ті самі відповіді, що й старі', async () => {
    for (const status of STATUSES) {
      for (const holderIsOwner of [true, false]) {
        const holder = holderIsOwner ? 'u-owner' : 'u-friend'
        const expected = oldCopyRulesAccept(status, holderIsOwner)
        const attempt = insertCopy(status, holder)

        if (expected) await expect(attempt).resolves.toEqual(expect.any(String))
        else await expect(attempt).rejects.toMatchObject({ code: '23514' })
      }
    }
  })

  it('MIG2: гість-тримач: LENT_OUT/UNAVAILABLE дозволені, AVAILABLE/RESERVED — ні', async () => {
    const contact = await insertContact()

    await expect(insertCopy('LENT_OUT', null, contact)).resolves.toEqual(expect.any(String))
    await expect(insertCopy('UNAVAILABLE', null, contact)).resolves.toEqual(expect.any(String))
    await expect(insertCopy('AVAILABLE', null, contact)).rejects.toMatchObject({
      constraint: 'copy_available_is_home',
    })
    await expect(insertCopy('RESERVED', null, contact)).rejects.toMatchObject({
      constraint: 'copy_away_is_lent_or_unavailable',
    })
  })

  it('MIG2: невідомий тримач (NULL/NULL, гостя стерто за D3) — «не вдома», а не «вдома»', async () => {
    await expect(insertCopy('LENT_OUT', null)).resolves.toEqual(expect.any(String))
    await expect(insertCopy('UNAVAILABLE', null)).resolves.toEqual(expect.any(String))
    // NULL-пастка: без COALESCE ці два рядки пройшли б CHECK-и.
    await expect(insertCopy('AVAILABLE', null)).rejects.toMatchObject({
      constraint: 'copy_available_is_home',
    })
    await expect(insertCopy('RESERVED', null)).rejects.toMatchObject({
      constraint: 'copy_away_is_lent_or_unavailable',
    })
  })

  it('MIG2: власник-тримач із контактом одночасно — не «вдома»; обидва тримачі — заборонено', async () => {
    const contact = await insertContact()

    await expect(insertCopy('LENT_OUT', 'u-owner', contact)).rejects.toMatchObject({
      constraint: 'copy_single_holder',
    })
    await expect(insertCopy('LENT_OUT', 'u-friend', contact)).rejects.toMatchObject({
      constraint: 'copy_single_holder',
    })
  })

  it('MIG2: Loan — гість без borrowerId, зареєстрований із borrowerId; змішування відхиляється', async () => {
    const contact = await insertContact()
    const copy = await insertCopy('AVAILABLE', 'u-owner')
    const insert = (
      kind: string,
      borrower: string | null,
      contactId: string | null,
      origin = 'RECORDED_GUEST',
      requestedAt: string | null = null,
    ): Promise<unknown> =>
      client.query(
        `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerContactId", "borrowerKind", origin, "requestedAt", status)
         VALUES ($1, $2, 'u-owner', $3, $4, $5::"BorrowerKind", $6::"LoanOrigin", $7::timestamp, 'RETURNED')`,
        [next('l'), copy, borrower, contactId, kind, origin, requestedAt],
      )

    await expect(insert('GUEST', null, contact)).resolves.toBeDefined()
    await expect(insert('GUEST', null, null)).resolves.toBeDefined()
    await expect(insert('GUEST', 'u-friend', contact)).rejects.toMatchObject({
      constraint: 'loan_borrower_kind_valid',
    })
    await expect(insert('REGISTERED', null, null, 'REQUESTED', '2026-01-01')).rejects.toMatchObject(
      {
        constraint: 'loan_borrower_kind_valid',
      },
    )
    await expect(
      insert('REGISTERED', 'u-friend', contact, 'REQUESTED', '2026-01-01'),
    ).rejects.toMatchObject({
      constraint: 'loan_borrower_kind_valid',
    })
    await expect(
      insert('REGISTERED', 'u-friend', null, 'REQUESTED', '2026-01-01'),
    ).resolves.toBeDefined()
  })

  it('MIG2: requestedAt = NULL лише для записаних власником позик', async () => {
    const copy = await insertCopy('AVAILABLE', 'u-owner')
    const insert = (origin: string): Promise<unknown> =>
      client.query(
        `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", origin, "requestedAt", status)
         VALUES ($1, $2, 'u-owner', 'u-friend', $3::"LoanOrigin", NULL, 'RETURNED')`,
        [next('l'), copy, origin],
      )

    await expect(insert('REQUESTED')).rejects.toMatchObject({
      constraint: 'loan_requested_has_request_time',
    })
    await expect(insert('RECORDED_EXISTING')).resolves.toBeDefined()
  })

  it('MIG2: видалення контакту → SET NULL у Loan і Copy; borrowerKind лишається GUEST', async () => {
    const contact = await insertContact()
    const copy = await insertCopy('LENT_OUT', null, contact)
    const loan = next('l')

    await client.query(
      `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerContactId", "borrowerKind", origin, "requestedAt", status)
       VALUES ($1, $2, 'u-owner', NULL, $3, 'GUEST', 'RECORDED_GUEST', NULL, 'HANDED_OVER')`,
      [loan, copy, contact],
    )

    await client.query(`DELETE FROM "ExternalBorrower" WHERE id = $1`, [contact])

    const l = await client.query<{
      borrowerKind: string
      borrowerContactId: string | null
      status: string
    }>(`SELECT "borrowerKind", "borrowerContactId", status FROM "Loan" WHERE id = $1`, [loan])
    const c = await client.query<{ heldByContactId: string | null; status: string }>(
      `SELECT "heldByContactId", status FROM "Copy" WHERE id = $1`,
      [copy],
    )

    expect(l.rows[0]).toEqual({
      borrowerKind: 'GUEST',
      borrowerContactId: null,
      status: 'HANDED_OVER',
    })
    expect(c.rows[0]).toEqual({ heldByContactId: null, status: 'LENT_OUT' })
  })

  it('MIG2: користувача-позичальника й тримача, як і раніше, видалити не можна (RESTRICT)', async () => {
    await expect(client.query(`DELETE FROM "User" WHERE id = 'u-friend'`)).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('MIG2: рядок Loan із подіями не видаляється; нові значення LoanStatus доступні', async () => {
    await client.query(
      `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ('ev-1', 'l-ret', 'RECOVERED')`,
    )

    await expect(client.query(`DELETE FROM "Loan" WHERE id = 'l-ret'`)).rejects.toMatchObject({
      code: '23503',
    })

    const copy = await insertCopy('AVAILABLE', 'u-owner')

    await client.query(
      `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, origin, "requestedAt")
       VALUES ($1, $2, 'u-owner', 'u-friend', 'PENDING_CONFIRMATION', 'RECORDED_EXISTING', NULL)`,
      [next('l'), copy],
    )
  })

  // MIG6
  it('MIG6: код попереднього релізу (INSERT лише зі старими колонками) працює після міграції', async () => {
    const copy = next('c')
    const loan = next('l')

    await client.query(
      `INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId") VALUES ($1, 'e-1', 'u-owner', 'u-owner')`,
      [copy],
    )
    await client.query(
      `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId") VALUES ($1, $2, 'u-owner', 'u-friend')`,
      [loan, copy],
    )

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT status, "requestedAt", "borrowerKind", origin, "createdAt" FROM "Loan" WHERE id = $1`,
      [loan],
    )

    expect(rows[0]).toMatchObject({
      status: 'REQUESTED',
      borrowerKind: 'REGISTERED',
      origin: 'REQUESTED',
    })
    expect(rows[0]?.requestedAt).toBeInstanceOf(Date)
    expect(rows[0]?.createdAt).toBeInstanceOf(Date)
  })
})

/**
 * Runbook `docs/runbooks/stage-10-migration-rollback.md`: SQL відкату лише вперед береться прямо з
 * документа, тож інструкція не може розійтися з реальністю. Виконується на порожніх (за
 * передумовами) новій таблицях наповненої БД — тобто в єдиному випадку, коли відкат схеми безпечний.
 */
describe('Stage 10 (10a): SQL відкату з runbook-у повертає схему до стану до M2', () => {
  let scratch: ScratchDatabase
  let client: Client

  function rollbackSql(): string {
    const runbook = readFileSync(
      join(__dirname, '../../../../docs/runbooks/stage-10-migration-rollback.md'),
      'utf8',
    )
    const block = /```sql\n(-- Відновлення попередніх CHECK-ів[\s\S]*?)```/.exec(runbook)

    if (block?.[1] === undefined) throw new Error('Блок SQL відкату не знайдено в runbook-у')

    return block[1]
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10rollback')
    client = scratch.client

    const dirs = listMigrationDirs()

    await applyMigrations(client, dirs.slice(0, dirs.indexOf(M1)))
    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-friend', 'friend@example.com', 'test-placeholder', 'Друг');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", status)
        VALUES ('c-1', 'e-1', 'u-owner', 'u-friend', 'LENT_OUT');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status)
        VALUES ('l-1', 'c-1', 'u-owner', 'u-friend', 'HANDED_OVER');
    `)
    await applyMigration(client, M1)
    await applyMigration(client, M2)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('після відкату: нових об’єктів немає, попередні CHECK-и знову чинні, дані цілі', async () => {
    await client.query(rollbackSql())

    const { rows: tables } = await client.query<{ e: string | null; l: string | null }>(
      `SELECT to_regclass('"ExternalBorrower"') AS e, to_regclass('"LoanEvent"') AS l`,
    )

    expect(tables[0]).toEqual({ e: null, l: null })

    const { rows: constraints } = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid IN ('"Copy"'::regclass, '"Loan"'::regclass) AND contype = 'c' ORDER BY conname`,
    )

    expect(constraints.map((row) => row.conname)).toEqual([
      'copy_available_is_home',
      'copy_away_is_lent_or_unavailable',
      'copy_lent_out_is_away',
      'loan_borrower_not_owner',
    ])

    const { rows: nullable } = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE (table_name = 'Copy' AND column_name = 'currentHolderId')
          OR (table_name = 'Loan' AND column_name IN ('borrowerId', 'requestedAt'))`,
    )

    expect(nullable.every((row) => row.is_nullable === 'NO')).toBe(true)

    const { rows } = await client.query<{ status: string }>(
      `SELECT c.status FROM "Copy" c JOIN "Loan" l ON l."copyId" = c.id WHERE l.status = 'HANDED_OVER'`,
    )

    expect(rows).toEqual([{ status: 'LENT_OUT' }])
  })
})
