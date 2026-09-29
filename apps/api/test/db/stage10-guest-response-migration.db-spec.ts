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
 * Stage 10, крок 10i.2 (docs/plan/stage-10-real-world-history.md, §6.12, §6.13, M9c/M9d): нові значення
 * `LoanEventType` (M9c) і expand-міграція посилання/виклику/доказу в `GuestLoanConfirmation` (M9d) —
 * застосовані до НАПОВНЕНОЇ БД зі станом після 10i.1 (відкритий і заперечений запити, ручна позика 10f.3).
 * Міграції лише додають: жоден наявний рядок не змінюється, крім нових колонок зі значеннями за замовчуванням.
 * Лише синтетичні дані (D2).
 */
const M9C = '20260929120000_stage10_guest_response_enum'
const M9D = '20260929120100_stage10_guest_response_expand'
const M9E = '20260929130000_stage10_guest_code_nonce'

describe('Stage 10 (10i.2): guest response migrations upgrade a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client
  let before: Record<'copies' | 'loans' | 'events' | 'contacts' | 'confirmations', unknown[]>

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
      confirmations: await rows('GuestLoanConfirmation'),
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

  const update = (set: string, id = 'gc-open'): string =>
    `UPDATE "GuestLoanConfirmation" SET ${set} WHERE id = '${id}'`

  beforeAll(async () => {
    scratch = await createScratchDatabase('stage10guestresp')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(M9C)

    if (index === -1) throw new Error(`Migration folder not found: ${M9C}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця');
      INSERT INTO "ExternalBorrower" (id, "ownerId", alias, "retainUntil") VALUES
        ('eb-1', 'u-owner', 'Гість 1', NULL),
        ('eb-2', 'u-owner', 'Гість 2', NULL),
        ('eb-3', 'u-owner', 'Гість 3', NULL);
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
        VALUES ('w-1', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Edition" (id, "workId", isbn13, "createdById")
        VALUES ('e-1', 'w-1', '9780306406157', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", "heldByContactId", status) VALUES
        ('c-open', 'e-1', 'u-owner', NULL, 'eb-1', 'RESERVED'),
        ('c-denied', 'e-1', 'u-owner', NULL, 'eb-2', 'RESERVED'),
        ('c-legacy', 'e-1', 'u-owner', NULL, 'eb-3', 'LENT_OUT');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", "borrowerKind", origin, "borrowerContactId", status, "requestedAt", "handedAt") VALUES
        ('l-open', 'c-open', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-1', 'PENDING_CONFIRMATION', NULL, now() - interval '3 days'),
        ('l-denied', 'c-denied', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-2', 'PENDING_CONFIRMATION', NULL, now() - interval '4 days'),
        ('l-legacy', 'c-legacy', 'u-owner', NULL, 'GUEST', 'RECORDED_GUEST', 'eb-3', 'HANDED_OVER', NULL, now() - interval '20 days');
      INSERT INTO "GuestLoanConfirmation" (id, "loanId", "externalBorrowerId", status) VALUES
        ('gc-open', 'l-open', 'eb-1', 'OPEN'),
        ('gc-denied', 'l-denied', 'eb-2', 'DENIED');
      INSERT INTO "LoanEvent" (id, "loanId", type) VALUES
        ('ev-1', 'l-open', 'GUEST_CONFIRMATION_REQUESTED'),
        ('ev-2', 'l-legacy', 'GUEST_LOAN_RECORDED');
    `)

    before = await snapshot()

    // M9c — окрема транзакція (нове значення enum не можна вжити в тій самій, де воно додане).
    await applyMigration(client, M9C)
    await applyMigration(client, M9D)
    // M9e — forward-міграція виправлення рев'ю (M9c/M9d не редагуються).
    await applyMigration(client, M9E)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('M9c+M9d не змінюють жодного наявного Copy/Loan/LoanEvent/ExternalBorrower; підтвердження лише отримують порожні нові колонки', async () => {
    expect(before.confirmations).toHaveLength(2)

    const after = await snapshot()

    expect(after.copies).toEqual(before.copies)
    expect(after.loans).toEqual(before.loans)
    expect(after.events).toEqual(before.events)
    expect(after.contacts).toEqual(before.contacts)
    expect(after.confirmations).toEqual(
      before.confirmations.map((row) => ({
        ...(row as object),
        linkTokenHash: null,
        linkIssuedAt: null,
        linkExpiresAt: null,
        challengeMac: null,
        codeHash: null,
        codeExpiresAt: null,
        codeNonce: null,
        codeAttempts: 0,
        codeFailedTotal: 0,
        codeSentCount: 0,
        codeWindowStartedAt: null,
        proofHash: null,
        proofExpiresAt: null,
        verifiedAt: null,
      })),
    )
  })

  it('старі ручні гостьові позики (10f.3) рядків підтвердження і посилань не отримують', async () => {
    const { rows: found } = await client.query(
      `SELECT * FROM "GuestLoanConfirmation" WHERE "loanId" = 'l-legacy'`,
    )

    expect(found).toHaveLength(0)
  })

  it('нові значення LoanEventType використовуються без помилки', async () => {
    for (const [i, type] of ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'].entries()) {
      await expect(
        client.query(
          `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ($1, 'l-open', $2::"LoanEventType")`,
          [`ev-new-${String(i)}`, type],
        ),
      ).resolves.toBeDefined()
    }
  })

  const LINK = `"linkTokenHash" = 'h1', "linkIssuedAt" = '2026-09-29 10:00:00', "linkExpiresAt" = '2026-10-06 10:00:00'`
  const NO_LINK = `"linkTokenHash" = NULL, "linkIssuedAt" = NULL, "linkExpiresAt" = NULL`
  const NO_CHALLENGE = `"challengeMac" = NULL, "codeHash" = NULL, "codeExpiresAt" = NULL, "codeNonce" = NULL, "proofHash" = NULL, "proofExpiresAt" = NULL, "verifiedAt" = NULL, "codeAttempts" = 0, "codeFailedTotal" = 0, "codeSentCount" = 0`

  /** Відомий чистий стан рядка: OPEN, без посилання, виклику й лічильників (обходить `violated`). */
  async function reset(id = 'gc-open'): Promise<void> {
    await client.query(
      update(`status = 'OPEN', "resolvedAt" = NULL, ${NO_LINK}, ${NO_CHALLENGE}`, id),
    )
  }

  describe('посилання: усе або нічого, рівно 7 діб, лише для OPEN, унікальний геш', () => {
    beforeEach(async () => {
      await reset()
      await reset('gc-denied')
      await client.query(update(`status = 'DENIED'`, 'gc-denied'))
    })

    it('повний комплект зі строком +7 діб для OPEN проходить', async () => {
      expect(await violated(update(LINK))).toBeUndefined()
    })

    it('часткове заповнення не проходить', async () => {
      for (const set of [
        `"linkTokenHash" = 'h1'`,
        `"linkIssuedAt" = '2026-09-29 10:00:00'`,
        `"linkExpiresAt" = '2026-10-06 10:00:00'`,
        `"linkTokenHash" = 'h1', "linkIssuedAt" = '2026-09-29 10:00:00'`,
      ]) {
        expect(await violated(update(set))).toBe('guest_confirmation_link_all_or_none')
      }
    })

    it('строк, що не дорівнює рівно 7 добам від видачі, не проходить', async () => {
      for (const expires of ['2026-10-06 10:00:01', '2026-10-05 10:00:00', '2026-09-29 10:00:00']) {
        expect(
          await violated(
            update(
              `"linkTokenHash" = 'h1', "linkIssuedAt" = '2026-09-29 10:00:00', "linkExpiresAt" = '${expires}'`,
            ),
          ),
        ).toBe('guest_confirmation_link_ttl')
      }
    })

    it('геш токена унікальний між підтвердженнями', async () => {
      await client.query(update(`status = 'OPEN'`, 'gc-denied'))
      await client.query(update(LINK))

      expect(await violated(update(LINK, 'gc-denied'))).toBe(
        'GuestLoanConfirmation_linkTokenHash_key',
      )
    })

    it('посилання для не-OPEN (DENIED/CANCELLED/OWNER_RECORDED/RECEIVED) не проходить', async () => {
      for (const status of ['DENIED', 'CANCELLED', 'OWNER_RECORDED', 'RECEIVED']) {
        const resolved = status === 'DENIED' ? 'NULL' : 'now()'

        expect(
          await violated(update(`status = '${status}', "resolvedAt" = ${resolved}, ${LINK}`)),
        ).toBe('guest_confirmation_link_only_open')
      }
    })
  })

  describe('M9e: codeNonce — ідентифікатор видачі коду (NULL ⇔ codeHash NULL)', () => {
    beforeEach(async () => {
      await reset()
      await client.query(update(LINK))
    })

    it('код із nonce проходить; код без nonce і nonce без коду — ні', async () => {
      const CODE_ONLY = `"challengeMac" = 'm', "codeHash" = 'c', "codeExpiresAt" = now() + interval '10 minutes'`

      expect(await violated(update(`${CODE_ONLY}, "codeNonce" = 'n'`))).toBeUndefined()
      expect(await violated(update(`"codeNonce" = NULL`))).toBe('guest_confirmation_code_nonce')

      await client.query(update(NO_CHALLENGE))

      expect(await violated(update(CODE_ONLY))).toBe('guest_confirmation_code_nonce')
      expect(await violated(update(`"codeNonce" = 'n'`))).toBe('guest_confirmation_code_nonce')
    })
  })

  describe('виклик перевірки email: код і доказ', () => {
    beforeEach(async () => {
      await reset()
      await client.query(update(LINK))
    })

    const CODE = `"challengeMac" = 'm', "codeHash" = 'c', "codeNonce" = 'n', "codeExpiresAt" = now() + interval '10 minutes'`
    const PROOF = `"challengeMac" = 'm', "proofHash" = 'p', "proofExpiresAt" = now() + interval '30 minutes', "verifiedAt" = now()`

    it('код із викликом і доказ із викликом проходять', async () => {
      expect(await violated(update(CODE))).toBeUndefined()
      await client.query(update(NO_CHALLENGE))
      expect(await violated(update(PROOF))).toBeUndefined()
    })

    it('код без виклику (challengeMac) і виклик без коду чи доказу не проходять', async () => {
      expect(
        await violated(update(`"codeHash" = 'c', "codeExpiresAt" = now() + interval '10 minutes'`)),
      ).toBe('guest_confirmation_challenge_consistent')
      expect(await violated(update(`"challengeMac" = 'm'`))).toBe(
        'guest_confirmation_challenge_consistent',
      )
    })

    it('hash і строк коду — разом; код і доказ одночасно не існують', async () => {
      expect(await violated(update(`"codeExpiresAt" = now()`))).toBe(
        'guest_confirmation_code_all_or_none',
      )
      expect(
        await violated(
          update(`${CODE}, "proofHash" = 'p', "proofExpiresAt" = now(), "verifiedAt" = now()`),
        ),
      ).toBe('guest_confirmation_code_xor_proof')
    })

    it('доказ: hash, строк і час перевірки — усе або нічого', async () => {
      for (const set of [
        `"challengeMac" = 'm', "proofHash" = 'p'`,
        `"challengeMac" = 'm', "proofHash" = 'p', "proofExpiresAt" = now()`,
        `"verifiedAt" = now()`,
        `"proofExpiresAt" = now()`,
      ]) {
        expect(await violated(update(set))).toBe('guest_confirmation_proof_all_or_none')
      }
    })

    it('виклик/доказ без чинного посилання не існують', async () => {
      await client.query(update(CODE))

      expect(await violated(update(NO_LINK))).toBe('guest_confirmation_challenge_needs_link')
    })

    it('лічильники не від’ємні', async () => {
      for (const column of ['codeAttempts', 'codeFailedTotal', 'codeSentCount']) {
        expect(await violated(update(`"${column}" = -1`))).toBe(
          'guest_confirmation_counters_non_negative',
        )
      }
    })

    it('погашення (посилання й виклик — NULL, лічильники 0) проходить для завершеного стану', async () => {
      await client.query(update(CODE))

      expect(
        await violated(
          update(`status = 'RECEIVED', "resolvedAt" = now(), ${NO_LINK}, ${NO_CHALLENGE}`),
        ),
      ).toBeUndefined()
    })
  })
})
