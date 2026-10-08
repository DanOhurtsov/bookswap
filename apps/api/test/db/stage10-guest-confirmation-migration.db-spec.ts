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
 * Stage 10, крок 10i.1 (docs/plan/stage-10-real-world-history.md, §0.13, §6.12, §6.13, M9a/M9b):
 * нові значення `LoanEventType` (M9a) і expand-міграція `GuestLoanConfirmation` + nullable поля
 * підтвердженого гостя в `ExternalBorrower` + послаблений CHECK `copy_away_is_lent_or_unavailable`
 * (M9b) — застосовані до НАПОВНЕНОЇ БД. Міграції лише додають/послаблюють: жоден наявний
 * `Copy`/`Loan`/`LoanEvent`/`ExternalBorrower` не змінюється, старі ручні гостьові позики рядків
 * підтвердження не отримують. Лише синтетичні дані (D2).
 */
const M9A = '20260929090000_stage10_guest_confirmation_enum'
const M9B = '20260929090100_stage10_guest_confirmation_expand'

describe('Stage 10 (10i.1): guest confirmation migrations upgrade a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: Record<'copies' | 'loans' | 'events' | 'contacts', unknown[]>

  async function rows(table: string): Promise<unknown[]> {
    const result = await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
    )

    return result.rows.map((r) => r.row)
  }

  async function snapshot(): Promise<typeof before> {
    return {
      copies: await rows('Copy'),
      loans: await rows('Loan'),
      events: await rows('LoanEvent'),
      contacts: await rows('ExternalBorrower'),
    }
  }

  /** Виконує SQL й повертає ім'я порушеного обмеження (`undefined`, якщо пройшло). */
  async function violated(sql: string, params: unknown[] = []): Promise<string | undefined> {
    try {
      await client.query(sql, params)

      return undefined
    } catch (error) {
      const { constraint, code } = error as { constraint?: string; code?: string }

      return constraint ?? code
    }
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10guestconf')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M9A)

    if (index === -1) throw new Error(`Migration folder not found: ${M9A}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-friend', 'friend@example.com', 'test-placeholder', 'Друг');
      INSERT INTO "ExternalBorrower" (id, "ownerId", alias, "retainUntil") VALUES
        ('eb-1', 'u-owner', 'Гість 1', NULL),
        ('eb-2', 'u-owner', 'Гість 2', now() + interval '10 days');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", "heldByContactId", status) VALUES
        ('c-home', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE'),
        ('c-guest', 'e-1', 'u-owner', NULL, 'eb-1', 'LENT_OUT'),
        ('c-friend', 'e-1', 'u-owner', 'u-friend', NULL, 'LENT_OUT'),
        ('c-new1', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE'),
        ('c-new2', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE'),
        ('c-new3', 'e-1', 'u-owner', 'u-owner', NULL, 'AVAILABLE');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerKind", origin, "borrowerContactId", status, "requestedAt", "handedAt") VALUES
        ('l-guest', 'c-guest', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-1', 'HANDED_OVER', NULL, now() - interval '20 days'),
        ('l-friend', 'c-friend', 'u-owner', 'u-friend', 'REGISTERED', 'REQUESTED', NULL, 'HANDED_OVER', now() - interval '30 days', now() - interval '25 days');
      INSERT INTO "LoanEvent" (id, "loanId", type) VALUES
        ('ev-1', 'l-guest', 'GUEST_LOAN_RECORDED');
    `)

    before = await snapshot()

    // M9a — окрема транзакція (нове значення enum не можна вжити в тій самій, де воно додане).
    await applyMigration(client, M9A)
    await applyMigration(client, M9B)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('M9a+M9b не змінюють жодного наявного Copy/Loan/LoanEvent, а ExternalBorrower лише отримує три NULL-колонки', async () => {
    expect(before.copies).toHaveLength(6)
    expect(before.loans).toHaveLength(2)
    expect(before.events).toHaveLength(1)

    const after = await snapshot()

    expect(after.copies).toEqual(before.copies)
    expect(after.loans).toEqual(before.loans)
    expect(after.events).toEqual(before.events)
    expect(after.contacts).toEqual(
      before.contacts.map((contact) => ({
        ...(contact as object),
        guestNickname: null,
        guestEmail: null,
        guestEmailVerifiedAt: null,
      })),
    )
  })

  it('старі ручні гостьові позики рядків підтвердження не отримують', async () => {
    const { rows: found } = await client.query(`SELECT * FROM "GuestLoanConfirmation"`)

    expect(found).toHaveLength(0)
  })

  it('нові значення LoanEventType використовуються без помилки', async () => {
    for (const [i, type] of [
      'GUEST_CONFIRMATION_REQUESTED',
      'GUEST_HANDOVER_CANCELLED',
      'GUEST_LOAN_OWNER_RECORDED',
    ].entries()) {
      await expect(
        client.query(
          `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ($1, 'l-guest', $2::"LoanEventType")`,
          [`ev-new-${String(i)}`, type],
        ),
      ).resolves.toBeDefined()
    }
  })

  describe('Copy: copy_away_is_lent_or_unavailable послаблено рівно для RESERVED у контакта', () => {
    it('RESERVED, яку тримає контакт, проходить', async () => {
      expect(
        await violated(
          `UPDATE "Copy" SET status = 'RESERVED', "currentHolderId" = NULL, "heldByContactId" = 'eb-1' WHERE id = 'c-new1'`,
        ),
      ).toBeUndefined()
    })

    it('RESERVED вдома, як і раніше, проходить', async () => {
      expect(
        await violated(`UPDATE "Copy" SET status = 'RESERVED' WHERE id = 'c-new2'`),
      ).toBeUndefined()
    })

    it('RESERVED поза домом без контакта (NULL-тримач чи чужий користувач) не проходить', async () => {
      expect(
        await violated(
          `UPDATE "Copy" SET status = 'RESERVED', "currentHolderId" = NULL WHERE id = 'c-new3'`,
        ),
      ).toBe('copy_away_is_lent_or_unavailable')
      expect(
        await violated(
          `UPDATE "Copy" SET status = 'RESERVED', "currentHolderId" = 'u-friend' WHERE id = 'c-new3'`,
        ),
      ).toBe('copy_away_is_lent_or_unavailable')
    })

    it('AVAILABLE у контакта, як і раніше, не проходить', async () => {
      expect(
        await violated(
          `UPDATE "Copy" SET status = 'AVAILABLE', "currentHolderId" = NULL, "heldByContactId" = 'eb-2' WHERE id = 'c-new3'`,
        ),
      ).toBe('copy_available_is_home')
    })
  })

  describe('ExternalBorrower: нікнейм, email і час перевірки — усе або нічого', () => {
    it('усі три разом проходять', async () => {
      expect(
        await violated(
          `UPDATE "ExternalBorrower" SET "guestNickname" = 'Синтетичний', "guestEmail" = 'g@guest.invalid', "guestEmailVerifiedAt" = now() WHERE id = 'eb-2'`,
        ),
      ).toBeUndefined()
    })

    it('часткове заповнення не проходить', async () => {
      for (const set of [
        `"guestNickname" = 'X'`,
        `"guestEmail" = 'g@guest.invalid'`,
        `"guestEmailVerifiedAt" = now()`,
        `"guestNickname" = 'X', "guestEmail" = 'g@guest.invalid'`,
      ]) {
        expect(await violated(`UPDATE "ExternalBorrower" SET ${set} WHERE id = 'eb-1'`)).toBe(
          'external_borrower_guest_identity_all_or_none',
        )
      }
    })

    it('alias власника при цьому не змінюється', async () => {
      const { rows: found } = await client.query<{ alias: string }>(
        `SELECT alias FROM "ExternalBorrower" WHERE id = 'eb-2'`,
      )

      expect(found[0]?.alias).toBe('Гість 2')
    })
  })

  describe('GuestLoanConfirmation', () => {
    it('OPEN без resolvedAt проходить; один рядок на позику (UNIQUE loanId)', async () => {
      expect(
        await violated(
          `INSERT INTO "GuestLoanConfirmation" (id, "loanId", "externalBorrowerId") VALUES ('gc-1', 'l-guest', 'eb-1')`,
        ),
      ).toBeUndefined()
      expect(
        await violated(
          `INSERT INTO "GuestLoanConfirmation" (id, "loanId", "externalBorrowerId") VALUES ('gc-dup', 'l-guest', 'eb-1')`,
        ),
      ).toBe('GuestLoanConfirmation_loanId_key')
    })

    it('resolvedAt узгоджений зі статусом (CHECK guest_loan_confirmation_resolved_at)', async () => {
      const insert = (id: string, loanId: string, status: string, resolved: string): string =>
        `INSERT INTO "GuestLoanConfirmation" (id, "loanId", status, "resolvedAt") VALUES ('${id}', '${loanId}', '${status}', ${resolved})`

      await client.query(
        `INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerKind", origin, status, "requestedAt", "handedAt") VALUES
          ('l-x1', 'c-home', 'u-owner', 'u-friend', 'REGISTERED', 'REQUESTED', 'REJECTED', now(), NULL),
          ('l-x2', 'c-home', 'u-owner', 'u-friend', 'REGISTERED', 'REQUESTED', 'REJECTED', now(), NULL),
          ('l-x3', 'c-home', 'u-owner', 'u-friend', 'REGISTERED', 'REQUESTED', 'REJECTED', now(), NULL),
          ('l-x4', 'c-home', 'u-owner', 'u-friend', 'REGISTERED', 'REQUESTED', 'REJECTED', now(), NULL)`,
      )

      expect(await violated(insert('gc-a', 'l-x1', 'OPEN', 'now()'))).toBe(
        'guest_loan_confirmation_resolved_at',
      )
      expect(await violated(insert('gc-b', 'l-x2', 'DENIED', 'now()'))).toBe(
        'guest_loan_confirmation_resolved_at',
      )
      expect(await violated(insert('gc-c', 'l-x3', 'CANCELLED', 'NULL'))).toBe(
        'guest_loan_confirmation_resolved_at',
      )
      expect(await violated(insert('gc-d', 'l-x3', 'CANCELLED', 'now()'))).toBeUndefined()
      expect(await violated(insert('gc-e', 'l-x4', 'DENIED', 'NULL'))).toBeUndefined()
    })

    it('видалення контакта: externalBorrowerId → NULL, рядок і Loan лишаються', async () => {
      await client.query(`UPDATE "Loan" SET "borrowerContactId" = NULL WHERE id = 'l-guest'`)
      await client.query(
        `UPDATE "Copy" SET "heldByContactId" = NULL, "currentHolderId" = 'u-owner', status = 'AVAILABLE' WHERE id = 'c-guest'`,
      )

      // `c-new1` (RESERVED у eb-1, див. вище) звільняємо, як це робить скасування передачі: `RESERVED` у
      // контакта не переживає його видалення (`SET NULL` дав би RESERVED без тримача — CHECK це
      // відхиляє гучно, а не мовчки). У застосунку це недосяжно: `PENDING_CONFIRMATION` ∈
      // `EXCLUSIVE_LOAN_STATUS` блокує ручний `DELETE` і CLI-чистку контакта.
      await client.query(
        `UPDATE "Copy" SET status = 'AVAILABLE', "currentHolderId" = 'u-owner', "heldByContactId" = NULL WHERE id = 'c-new1'`,
      )
      await client.query(`DELETE FROM "ExternalBorrower" WHERE id = 'eb-1'`)

      const { rows: found } = await client.query<{ externalBorrowerId: string | null }>(
        `SELECT "externalBorrowerId" FROM "GuestLoanConfirmation" WHERE id = 'gc-1'`,
      )

      expect(found).toHaveLength(1)
      expect(found[0]?.externalBorrowerId).toBeNull()
    })

    it('Loan із рядком підтвердження видалити не можна (RESTRICT)', async () => {
      expect(await violated(`DELETE FROM "Loan" WHERE id = 'l-guest'`)).toBeDefined()
    })
  })
})
