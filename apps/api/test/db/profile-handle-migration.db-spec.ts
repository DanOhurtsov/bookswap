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
 * BS-148, підетап A (docs/plan/bs-148-profile-design.md): нік і місто користувача.
 *
 * Міграція накочується на НАПОВНЕНУ базу попередньої схеми. Перевіряється: кожен наявний користувач отримав
 * свій нік у потрібному форматі, решта даних не змінилася, а вставка у стилі попередньої збірки (без ніка)
 * далі працює — нік видає DEFAULT. Формат і унікальність тримає сама база.
 */
const MIGRATION = '20261026090000_profile_handle_city'
const HANDLE_FORMAT = /^user\d{8}$/

describe('BS-148: нік і місто користувача', () => {
  let scratch: ScratchDatabase
  let client: Client
  let usersBefore: unknown[]

  async function users(): Promise<Record<string, unknown>[]> {
    const { rows } = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(u) AS row FROM "User" u ORDER BY id`,
    )

    return rows.map((r) => r.row)
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('bs148handle')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(MIGRATION)

    if (index === -1) throw new Error(`Migration folder not found: ${MIGRATION}`)

    await applyMigrations(client, dirs.slice(0, index))

    await client.query(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName", "avatarUrl", bio, "createdAt") VALUES
        ('u-1', 'one@example.com', 'test-placeholder', 'Перша', 'https://example.com/a.png', 'Біо', now() - interval '3 days'),
        ('u-2', 'two@example.com', 'test-placeholder', 'Друга', NULL, NULL, now() - interval '2 days'),
        ('u-3', 'three@example.com', 'test-placeholder', 'Третя', NULL, NULL, now() - interval '1 day');
    `)

    usersBefore = await users()

    await applyMigration(client, MIGRATION)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('кожен наявний користувач отримав нік `user` + 8 цифр, різний для всіх', async () => {
    const { rows } = await client.query<{ handle: string }>(`SELECT handle FROM "User" ORDER BY id`)

    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.handle).toMatch(HANDLE_FORMAT)
    expect(new Set(rows.map((row) => row.handle)).size).toBe(3)
  })

  it('решта даних не змінилася, місто порожнє', async () => {
    // The new `handle` is checked above; every other column, `city` included, must read as before.
    const withoutHandle = (await users()).map((row) => {
      const { handle: _handle, ...rest } = row

      void _handle

      return rest
    })

    expect(withoutHandle).toEqual(
      usersBefore.map((row) => ({ ...(row as Record<string, unknown>), city: null })),
    )
  })

  it('вставка у стилі попередньої збірки (без ніка) отримує нік від бази', async () => {
    const { rows } = await client.query<{ handle: string }>(`
      INSERT INTO "User" (id, email, "passwordHash", "displayName")
      VALUES ('u-old-build', 'old@example.com', 'test-placeholder', 'Стара збірка')
      RETURNING handle
    `)

    expect(rows[0]?.handle).toMatch(HANDLE_FORMAT)
  })

  it('база відхиляє нік поза форматом', async () => {
    for (const handle of [
      'ab',
      'Upper',
      '-edge',
      'edge_',
      'two--seps',
      'a'.repeat(31),
      'пробіл ніка',
    ]) {
      await expect(
        client.query(`UPDATE "User" SET handle = $1 WHERE id = 'u-1'`, [handle]),
      ).rejects.toThrow(/user_handle_format/)
    }
  })

  it('приймає нік у форматі, зокрема з дефісом і підкресленням', async () => {
    await client.query(`UPDATE "User" SET handle = 'danylo-ohurtsov_2' WHERE id = 'u-1'`)

    const { rows } = await client.query<{ handle: string }>(
      `SELECT handle FROM "User" WHERE id = 'u-1'`,
    )

    expect(rows[0]?.handle).toBe('danylo-ohurtsov_2')
  })

  it('два користувачі не можуть мати один нік', async () => {
    await expect(
      client.query(`UPDATE "User" SET handle = 'danylo-ohurtsov_2' WHERE id = 'u-2'`),
    ).rejects.toThrow(/User_handle_key/)
  })
})
