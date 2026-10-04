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
 * Швидке додавання, етап D (docs/plan/fast-book-add.md, §5.3; реліз R4): зовнішні посилання на видання.
 * Міграція лише додає таблицю й знімає `DEFAULT PAPERBACK` з `Edition.format`: формат без відомостей від
 * джерела лишається невідомим. Наявні рядки (зокрема їхній формат) не змінюються.
 */
const D = '20261001120000_fast_add_external_refs'

describe('fast-add D: зовнішні посилання на видання', () => {
  let scratch: ScratchDatabase
  let client: Client

  beforeAll(async () => {
    scratch = await createScratchDatabase('fastaddd')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(D)

    if (index === -1) throw new Error(`Migration folder not found: ${D}`)

    await applyMigrations(client, dirs.slice(0, index))
    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-1', 'one@example.com', 'test-placeholder', 'Перший');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById") VALUES
        ('w-1', 'Книжка', 'книжка', 'uk', 'u-1');
      INSERT INTO "Edition" (id, "workId", "textKind", lang, format, "createdById") VALUES
        ('e-1', 'w-1', 'ORIGINAL', 'uk', 'PAPERBACK', 'u-1'),
        ('e-2', 'w-1', 'UNKNOWN', NULL, 'HARDCOVER', 'u-1');
    `)

    await applyMigration(client, D)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('наявні видання зберегли формат: знято лише DEFAULT, а не значення', async () => {
    const { rows } = await client.query<{ id: string; format: string }>(
      `SELECT id, format FROM "Edition" ORDER BY id`,
    )

    expect(rows).toEqual([
      { id: 'e-1', format: 'PAPERBACK' },
      { id: 'e-2', format: 'HARDCOVER' },
    ])
  })

  it('нове видання без формату лишається з невідомим форматом, а не «мʼякою палітуркою»', async () => {
    await client.query(
      `INSERT INTO "Edition" (id, "workId", "textKind", "createdById") VALUES ('e-3', 'w-1', 'UNKNOWN', 'u-1')`,
    )

    const { rows } = await client.query<{ format: string | null }>(
      `SELECT format FROM "Edition" WHERE id = 'e-3'`,
    )

    expect(rows[0]?.format).toBeNull()
  })

  it('enum ExternalBookSource і порожня таблиця посилань', async () => {
    const labels = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ExternalBookSource' ORDER BY e.enumsortorder`,
    )
    const count = await client.query<{ count: string }>(
      `SELECT count(*) FROM "EditionExternalReference"`,
    )

    expect(labels.rows.map((row) => row.enumlabel)).toEqual([
      'OPEN_LIBRARY',
      'GOOGLE_BOOKS',
      'ISBNDB',
    ])
    expect(count.rows[0]?.count).toBe('0')
  })

  it('пара (source, externalId) унікальна: те саме посилання не перепривʼязується іншому виданню', async () => {
    const insert = (id: string, externalId: string, editionId: string): Promise<unknown> =>
      client.query(
        `INSERT INTO "EditionExternalReference" (id, source, "externalId", "editionId")
         VALUES ($1, 'GOOGLE_BOOKS', $2, $3)`,
        [id, externalId, editionId],
      )

    await insert('r-1', 'vol-1', 'e-1')

    await expect(insert('r-2', 'vol-1', 'e-2')).rejects.toMatchObject({
      code: '23505',
      constraint: 'EditionExternalReference_source_externalId_key',
    })
    // Інше видання може мати власні посилання; те саме externalId іншого джерела — окремий запис.
    await expect(insert('r-3', 'vol-2', 'e-2')).resolves.toBeDefined()
    await expect(
      client.query(
        `INSERT INTO "EditionExternalReference" (id, source, "externalId", "editionId")
         VALUES ('r-4', 'OPEN_LIBRARY', 'vol-1', 'e-2')`,
      ),
    ).resolves.toBeDefined()
  })

  it('невідоме джерело відхиляється enum-ом; посилання на неіснуюче видання — зовнішнім ключем', async () => {
    await expect(
      client.query(
        `INSERT INTO "EditionExternalReference" (id, source, "externalId", "editionId")
         VALUES ('r-bad', 'GOODREADS', 'x', 'e-1')`,
      ),
    ).rejects.toMatchObject({ code: '22P02' })
    await expect(
      client.query(
        `INSERT INTO "EditionExternalReference" (id, source, "externalId", "editionId")
         VALUES ('r-orphan', 'GOOGLE_BOOKS', 'x', 'no-such-edition')`,
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
