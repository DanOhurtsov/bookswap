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
 * BS-114 (docs/plan/fast-book-add.md, §13): підтверджені посилання на зовнішній ТВІР. Лише expand: нове значення
 * `LibraryAddTargetKind` і нова таблиця; наявні рядки не змінюються.
 */
const ENUM = '20261015090000_external_work_target_enum'
const REFS = '20261015090100_external_work_refs'

describe('BS-114: посилання на зовнішній твір', () => {
  let scratch: ScratchDatabase
  let client: Client

  beforeAll(async () => {
    scratch = await createScratchDatabase('olwork')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(ENUM)

    if (index === -1 || dirs[index + 1] !== REFS) throw new Error('Міграції BS-114 не знайдено')

    await applyMigrations(client, dirs.slice(0, index))
    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-1', 'one@example.com', 'test-placeholder', 'Перший');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById") VALUES
        ('w-1', 'Книжка', 'книжка', 'uk', 'u-1'),
        ('w-2', 'Інша', 'інша', NULL, 'u-1');
      INSERT INTO "Edition" (id, "workId", "textKind", lang, "coverUrl", "createdById") VALUES
        ('e-1', 'w-1', 'ORIGINAL', 'uk', 'https://example.com/c.jpg', 'u-1');
      INSERT INTO "LibraryAddOperation" (id, "userId", "operationId", "requestHash", "targetKind", "editionId") VALUES
        ('op-1', 'u-1', '3f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11', 'h', 'EXTERNAL_EDITION', 'e-1');
    `)

    await applyMigration(client, ENUM)
    await applyMigration(client, REFS)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('наявні твори, видання й операції не змінилися', async () => {
    const works = await client.query(`SELECT id, "origLang" FROM "Work" ORDER BY id`)
    const editions = await client.query(`SELECT id, "coverUrl", lang FROM "Edition"`)
    const operations = await client.query(`SELECT id, "targetKind" FROM "LibraryAddOperation"`)

    expect(works.rows).toEqual([
      { id: 'w-1', origLang: 'uk' },
      { id: 'w-2', origLang: null },
    ])
    expect(editions.rows).toEqual([
      { id: 'e-1', coverUrl: 'https://example.com/c.jpg', lang: 'uk' },
    ])
    expect(operations.rows).toEqual([{ id: 'op-1', targetKind: 'EXTERNAL_EDITION' }])
  })

  it('нове значення EXTERNAL_WORK приймається журналом операцій', async () => {
    await expect(
      client.query(
        `INSERT INTO "LibraryAddOperation" (id, "userId", "operationId", "requestHash", "targetKind", "editionId")
         VALUES ('op-2', 'u-1', '4f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11', 'h', 'EXTERNAL_WORK', 'e-1')`,
      ),
    ).resolves.toBeDefined()
  })

  it('запис твору джерела веде рівно до одного нашого твору; editionId необовʼязковий', async () => {
    const insert = (id: string, externalId: string, workId: string, editionId: string | null) =>
      client.query(
        `INSERT INTO "WorkExternalReference" (id, source, "externalId", "workId", "editionId")
         VALUES ($1, 'OPEN_LIBRARY', $2, $3, $4)`,
        [id, externalId, workId, editionId],
      )

    await insert('r-1', 'OL1W', 'w-1', 'e-1')
    await insert('r-2', 'OL2W', 'w-2', null)

    await expect(insert('r-3', 'OL1W', 'w-2', null)).rejects.toMatchObject({
      code: '23505',
      constraint: 'WorkExternalReference_source_externalId_key',
    })
    await expect(insert('r-4', 'OL3W', 'no-such-work', null)).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('видалене видання лише відвʼязується від посилання; посилання на твір лишається', async () => {
    await client.query(`DELETE FROM "LibraryAddOperation" WHERE "editionId" = 'e-1'`)
    await client.query(`DELETE FROM "Edition" WHERE id = 'e-1'`)

    const { rows } = await client.query(
      `SELECT "workId", "editionId" FROM "WorkExternalReference" WHERE id = 'r-1'`,
    )

    expect(rows).toEqual([{ workId: 'w-1', editionId: null }])
  })
})
