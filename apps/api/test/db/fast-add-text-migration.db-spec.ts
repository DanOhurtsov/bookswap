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
 * Швидке додавання, етап C (docs/plan/fast-book-add.md, §4; ред. 2, §2): тип тексту й мова видання.
 *
 * Дві міграції, кожна безпечна для попереднього релізу:
 *
 *  - **C1** (`…_fast_add_edition_text_expand`, R2): лише послаблює й додає. `Work.origLang` і
 *    `Edition.format` стають nullable, з'являються `Edition.textKind` (nullable) і `Edition.lang`.
 *    `DEFAULT PAPERBACK` лишається: код попередніх релізів вставляє видання без формату.
 *  - **C2** (R3): ідемпотентний backfill, `textKind NOT NULL`, CHECK I1.
 *
 * Тест накочує історію до кожної з них на НАПОВНЕНІЙ базі (усі види видань, позики, історія виправлень) і
 * перевіряє: наявні рядки збережені, нові колонки не вигадують даних, вставки у стилі попереднього релізу
 * далі працюють, а backfill відтворює рівно те, що попередній код обчислював на льоту.
 */
const C1 = '20261001100000_fast_add_edition_text_expand'
const C2 = '20261001110000_fast_add_edition_text_contract'

describe('fast-add C1: expand — тип тексту й мова видання', () => {
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
    scratch = await createScratchDatabase('fastaddc1')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(C1)

    if (index === -1) throw new Error(`Migration folder not found: ${C1}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-reader', 'reader@example.com', 'test-placeholder', 'Читач');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById") VALUES
        ('w-en', 'The Hobbit', 'the hobbit', 'en', 'u-owner'),
        ('w-uk', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner');
      INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang", "createdById") VALUES
        ('t-uk', 'w-en', 'Олена Оніщук', 'uk', 'en', 'u-owner');
      INSERT INTO "Edition" (id, "workId", "translationId", publisher, year, isbn13, format, "createdById") VALUES
        ('e-orig', 'w-en', NULL, 'Allen & Unwin', 1937, '9780261102217', 'PAPERBACK', 'u-owner'),
        ('e-tr', 'w-en', 't-uk', 'Астролябія', 2021, '9786176642411', 'HARDCOVER', 'u-owner'),
        ('e-uk', 'w-uk', NULL, NULL, NULL, NULL, 'POCKET', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", status) VALUES
        ('c-1', 'e-orig', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-2', 'e-tr', 'u-owner', 'u-reader', 'LENT_OUT');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt") VALUES
        ('l-1', 'c-2', 'u-owner', 'u-reader', 'HANDED_OVER', now() - interval '5 days');
      INSERT INTO "WishlistItem" (id, "userId", "workId") VALUES ('wi-1', 'u-reader', 'w-en');
      INSERT INTO "CatalogRevision" (id, "entityType", "entityId", "actorId", before, after, "fromRevision", "toRevision") VALUES
        ('r-1', 'EDITION', 'e-orig', 'u-owner',
         '{"publisher":null,"year":null,"isbn13":null,"pageCount":null,"coverUrl":null,"format":"PAPERBACK","translationId":null}',
         '{"publisher":"Allen & Unwin","year":1937,"isbn13":null,"pageCount":null,"coverUrl":null,"format":"PAPERBACK","translationId":null}',
         1, 2);
    `)

    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
    )

    tables = rows.map((row) => row.tablename)
    before = await snapshot()

    await applyMigration(client, C1)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('до C1 колонок немає, дані наповнені (видання трьох видів, позика, журнал виправлень)', () => {
    expect(before['Edition']).toHaveLength(3)
    expect(before['Loan']).toHaveLength(1)
    expect(before['CatalogRevision']).toHaveLength(1)
  })

  it('жоден наявний рядок не змінився: кількість і значення всіх старих колонок (MIG1)', async () => {
    const after = await snapshot()

    // Нові колонки Edition з'являються як NULL — вони не «змінюють» наявних даних; усе інше збігається.
    const withoutNew = (rows: unknown[]): unknown[] =>
      rows.map((row) => {
        const { lang: _lang, textKind: _textKind, ...rest } = row as Record<string, unknown>

        void _lang
        void _textKind

        return rest
      })

    expect({ ...after, Edition: withoutNew(after['Edition'] ?? []) }).toEqual(before)
  })

  it('нові колонки порожні для всіх наявних видань: нічого не вигадано', async () => {
    const { rows } = await client.query<{ total: string; typed: string; langs: string }>(
      `SELECT count(*) AS total, count("textKind") AS typed, count(lang) AS langs FROM "Edition"`,
    )

    expect(rows[0]).toEqual({ total: '3', typed: '0', langs: '0' })
  })

  it('enum EditionTextKind: ORIGINAL, TRANSLATION, UNKNOWN', async () => {
    const { rows } = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'EditionTextKind' ORDER BY e.enumsortorder`,
    )

    expect(rows.map((row) => row.enumlabel)).toEqual(['ORIGINAL', 'TRANSLATION', 'UNKNOWN'])
  })

  it('код попереднього релізу (R1) далі працює: вставка видання лише зі старими колонками (MIG6)', async () => {
    await client.query(
      `INSERT INTO "Edition" (id, "workId", "translationId", publisher, "createdById")
       VALUES ('e-r1', 'w-en', NULL, 'Вставка R1', 'u-owner')`,
    )

    const { rows } = await client.query<{
      format: string
      textKind: string | null
      lang: string | null
    }>(`SELECT format, "textKind", lang FROM "Edition" WHERE id = 'e-r1'`)

    // DEFAULT PAPERBACK збережено навмисно; нові колонки — NULL, і читачі R2 виводять їх зі старої семантики.
    expect(rows[0]).toEqual({ format: 'PAPERBACK', textKind: null, lang: null })
  })

  it('твір без відомої мови оригіналу й видання без формату тепер допустимі (для R4)', async () => {
    await client.query(
      `INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById")
       VALUES ('w-null', 'Без мови', 'без мови', NULL, 'u-owner')`,
    )
    await client.query(
      `INSERT INTO "Edition" (id, "workId", format, "textKind", lang, "createdById")
       VALUES ('e-null', 'w-null', NULL, 'UNKNOWN', NULL, 'u-owner')`,
    )

    const { rows } = await client.query<{ format: string | null; textKind: string }>(
      `SELECT format, "textKind" FROM "Edition" WHERE id = 'e-null'`,
    )

    expect(rows[0]).toEqual({ format: null, textKind: 'UNKNOWN' })
  })

  it('старі знімки аудиту (без textKind і lang) залишаються читабельними', async () => {
    const { rows } = await client.query<{ before: Record<string, unknown> }>(
      `SELECT before FROM "CatalogRevision" WHERE id = 'r-1'`,
    )

    expect(rows[0]?.before).not.toHaveProperty('textKind')
    expect(rows[0]?.before).toHaveProperty('format', 'PAPERBACK')
  })
})

describe('fast-add C2: contract — backfill, NOT NULL, CHECK I1', () => {
  let scratch: ScratchDatabase
  let client: Client
  let tables: string[]
  let before: Record<string, unknown[]>

  const TEXT_COLUMNS = ['lang', 'textKind']

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {}

    for (const table of tables) {
      const { rows } = await client.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )

      result[table] = rows.map(({ row }) => {
        if (table !== 'Edition') return row

        // Нові текстові колонки перевіряються окремо: тут лише те, що існувало ДО міграції.
        return Object.fromEntries(
          Object.entries(row).filter(([key]) => !TEXT_COLUMNS.includes(key)),
        )
      })
    }

    return result
  }

  const edition = async (id: string) =>
    (
      await client.query<{
        textKind: string | null
        lang: string | null
        translationId: string | null
      }>(`SELECT "textKind", lang, "translationId" FROM "Edition" WHERE id = $1`, [id])
    ).rows[0]

  beforeAll(async () => {
    scratch = await createScratchDatabase('fastaddc2')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(C2)

    if (index === -1) throw new Error(`Migration folder not found: ${C2}`)

    // Усе до C2 включно з C1: стан бази під код R2.
    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName") VALUES
        ('u-owner', 'owner@example.com', 'test-placeholder', 'Власниця'),
        ('u-reader', 'reader@example.com', 'test-placeholder', 'Читач');
      INSERT INTO "Work" (id, title, "titleNorm", "origLang", "createdById") VALUES
        ('w-en', 'The Hobbit', 'the hobbit', 'en', 'u-owner'),
        ('w-uk', 'Лісова пісня', 'лісова пісня', 'uk', 'u-owner'),
        ('w-null', 'Без мови', 'без мови', NULL, 'u-owner');
      INSERT INTO "Translation" (id, "workId", translator, lang, "sourceLang", "createdById") VALUES
        ('t-uk', 'w-en', 'Олена Оніщук', 'uk', 'en', 'u-owner'),
        ('t-pl', 'w-en', 'Хтось', 'pl', 'en', 'u-owner');
      -- Легасі-рядки (код R0/R1 не знає про нові колонки): textKind і lang порожні.
      INSERT INTO "Edition" (id, "workId", "translationId", publisher, isbn13, format, "createdById") VALUES
        ('e-legacy-orig', 'w-en', NULL, 'Allen & Unwin', '9780261102217', 'PAPERBACK', 'u-owner'),
        ('e-legacy-tr', 'w-en', 't-uk', 'Астролябія', '9786176642411', 'HARDCOVER', 'u-owner'),
        ('e-legacy-tr-pl', 'w-en', 't-pl', NULL, NULL, 'POCKET', 'u-owner'),
        ('e-legacy-uk', 'w-uk', NULL, NULL, NULL, 'POCKET', 'u-owner');
      -- Рядки, записані кодом R2: значення явні, backfill їх не чіпає.
      INSERT INTO "Edition" (id, "workId", "translationId", "textKind", lang, format, "createdById") VALUES
        ('e-r2-orig', 'w-en', NULL, 'ORIGINAL', 'en', 'PAPERBACK', 'u-owner'),
        ('e-r2-unknown', 'w-null', NULL, 'UNKNOWN', 'de', NULL, 'u-owner'),
        ('e-r2-unknown-nolang', 'w-null', NULL, 'UNKNOWN', NULL, NULL, 'u-owner'),
        ('e-r2-tr-nolink', 'w-uk', NULL, 'TRANSLATION', 'uk', 'PAPERBACK', 'u-owner');
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId", status) VALUES
        ('c-1', 'e-legacy-orig', 'u-owner', 'u-owner', 'AVAILABLE'),
        ('c-2', 'e-legacy-tr', 'u-owner', 'u-reader', 'LENT_OUT');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status, "handedAt") VALUES
        ('l-1', 'c-2', 'u-owner', 'u-reader', 'HANDED_OVER', now() - interval '5 days');
    `)

    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
    )

    tables = rows.map((row) => row.tablename)
    before = await snapshot()

    await applyMigration(client, C2)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('backfill відтворює рівно те, що попередній код обчислював на льоту', async () => {
    expect(await edition('e-legacy-orig')).toEqual({
      textKind: 'ORIGINAL',
      lang: 'en',
      translationId: null,
    })
    expect(await edition('e-legacy-uk')).toEqual({
      textKind: 'ORIGINAL',
      lang: 'uk',
      translationId: null,
    })
    expect(await edition('e-legacy-tr')).toEqual({
      textKind: 'TRANSLATION',
      lang: 'uk',
      translationId: 't-uk',
    })
    expect(await edition('e-legacy-tr-pl')).toEqual({
      textKind: 'TRANSLATION',
      lang: 'pl',
      translationId: 't-pl',
    })
  })

  it('рядки, записані R2, і введені людиною значення не чіпаються', async () => {
    expect(await edition('e-r2-orig')).toEqual({
      textKind: 'ORIGINAL',
      lang: 'en',
      translationId: null,
    })
    expect(await edition('e-r2-unknown')).toEqual({
      textKind: 'UNKNOWN',
      lang: 'de',
      translationId: null,
    })
    expect(await edition('e-r2-unknown-nolang')).toEqual({
      textKind: 'UNKNOWN',
      lang: null,
      translationId: null,
    })
    expect(await edition('e-r2-tr-nolink')).toEqual({
      textKind: 'TRANSLATION',
      lang: 'uk',
      translationId: null,
    })
  })

  it('усі ID, зв\u02bcязки, позики й решта таблиць збережені: змінилися лише нові колонки видань', async () => {
    expect(await snapshot()).toEqual(before)
  })

  it('backfill ідемпотентний: повторне виконання нічого не змінює', async () => {
    const sql = readFileSync(join(__dirname, `../../prisma/migrations/${C2}/migration.sql`), 'utf8')
    const updates = sql.slice(0, sql.indexOf('-- AlterTable'))
    const textBefore = (
      await client.query(`SELECT id, "textKind", lang FROM "Edition" ORDER BY id`)
    ).rows

    await client.query(updates)

    expect(
      (await client.query(`SELECT id, "textKind", lang FROM "Edition" ORDER BY id`)).rows,
    ).toEqual(textBefore)
  })

  it('textKind обов\u02bcязковий: вставка без нього (код R0/R1) відхиляється — тому відкат можливий лише на R2', async () => {
    await expect(
      client.query(
        `INSERT INTO "Edition" (id, "workId", "createdById") VALUES ('e-old-code', 'w-en', 'u-owner')`,
      ),
    ).rejects.toMatchObject({ code: '23502' })
  })

  it('CHECK I1: з прив\u02bcязаним перекладом — лише TRANSLATION', async () => {
    for (const kind of ['ORIGINAL', 'UNKNOWN']) {
      await expect(
        client.query(
          `INSERT INTO "Edition" (id, "workId", "translationId", "textKind", "createdById")
           VALUES ('e-bad-${kind}', 'w-en', 't-uk', '${kind}', 'u-owner')`,
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'edition_translation_implies_translation_kind',
      })
    }

    await expect(
      client.query(
        `INSERT INTO "Edition" (id, "workId", "translationId", "textKind", lang, "createdById")
         VALUES ('e-ok-linked', 'w-en', 't-uk', 'TRANSLATION', 'uk', 'u-owner')`,
      ),
    ).resolves.toBeDefined()
  })

  it('без зв\u02bcязку допустимі всі три типи тексту, і мова може бути невідомою', async () => {
    await expect(
      client.query(`
        INSERT INTO "Edition" (id, "workId", "textKind", lang, "createdById") VALUES
          ('e-n-orig', 'w-en', 'ORIGINAL', NULL, 'u-owner'),
          ('e-n-unknown', 'w-en', 'UNKNOWN', NULL, 'u-owner'),
          ('e-n-tr', 'w-en', 'TRANSLATION', 'uk', 'u-owner')`),
    ).resolves.toBeDefined()
  })

  it('невідома мова не вигадується backfill-ом: UNKNOWN без мови лишається без мови', async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM "Edition" WHERE id = 'e-r2-unknown-nolang' AND lang IS NULL`,
    )

    expect(rows[0]?.count).toBe('1')
  })
})
