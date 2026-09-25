import type { Client } from 'pg'
import {
  applyMigration,
  applyMigrations,
  createScratchDatabase,
  SCRATCH_CLEANUP_TIMEOUT_MS,
  listMigrationDirs,
  type ScratchDatabase,
} from './migration-scratch'

/**
 * Stage 9 (docs/plan/stage-9-network-activation.md, §9): the `stage9_invitations`
 * migration as an UPGRADE of a populated database. Only adds tables — nothing that
 * existed before may change.
 */
const MIGRATION = '20260925090000_stage9_invitations'

const PRESERVED_TABLES = [
  'User',
  'Friendship',
  'Work',
  'Edition',
  'Copy',
  'Loan',
  'ProductEvent',
] as const

describe('Stage 9: stage9_invitations migration upgrades a populated database', () => {
  let scratch: ScratchDatabase
  let client: Client

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {}

    for (const table of PRESERVED_TABLES) {
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
      result[table] = rows.map((entry) => entry.row)
    }

    return result
  }

  let before: Record<string, unknown[]>

  beforeAll(async () => {
    scratch = await createScratchDatabase('invitations')
    client = scratch.client

    const dirs = listMigrationDirs()
    const index = dirs.indexOf(MIGRATION)

    if (index === -1) throw new Error(`Migration folder not found: ${MIGRATION}`)

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
      INSERT INTO "Copy" (id, "editionId", "ownerId", "currentHolderId")
        VALUES ('c-1', 'e-1', 'u-owner', 'u-owner');
      INSERT INTO "Loan" (id, "copyId", "ownerId", "borrowerId", status)
        VALUES ('l-1', 'c-1', 'u-owner', 'u-friend', 'RETURNED');
      INSERT INTO "ProductEvent" (id, type, properties, "dedupeKey", "subjectUserId")
        VALUES ('pe-1', 'BOOK_ADDED', '{"method":"MANUAL"}', 'dedupe-1', 'u-owner');
    `)

    before = await snapshot()

    await applyMigration(client, MIGRATION)
  })

  afterAll(async () => {
    await scratch.cleanup()
  }, SCRATCH_CLEANUP_TIMEOUT_MS)

  it('every pre-existing row survives unchanged and the new tables start empty', async () => {
    for (const table of PRESERVED_TABLES) expect(before[table]).not.toHaveLength(0)

    expect(await snapshot()).toEqual(before)

    const { rows } = await client.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM "Invitation") + (SELECT count(*) FROM "InvitationAcceptance") AS count`,
    )

    expect(rows[0]?.count).toBe('0')
  })

  it('tokenHash is unique and an acceptance is unique per (invitation, user)', async () => {
    await client.query(
      `INSERT INTO "Invitation" (id, "inviterId", kind, "tokenHash", "maxUses", "expiresAt")
       VALUES ('i-1', 'u-owner', 'LINK', 'hash-1', 10, now() + interval '14 days')`,
    )

    await expect(
      client.query(
        `INSERT INTO "Invitation" (id, "inviterId", kind, "tokenHash", "maxUses", "expiresAt")
         VALUES ('i-2', 'u-owner', 'LINK', 'hash-1', 10, now() + interval '14 days')`,
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await client.query(
      `INSERT INTO "InvitationAcceptance" (id, "invitationId", "userId") VALUES ('a-1', 'i-1', 'u-friend')`,
    )

    await expect(
      client.query(
        `INSERT INTO "InvitationAcceptance" (id, "invitationId", "userId") VALUES ('a-2', 'i-1', 'u-friend')`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('deleting the inviter cascades to their invitations and acceptances only', async () => {
    await client.query(
      `INSERT INTO "User" (id, email, "passwordHash", "displayName")
       VALUES ('u-temp', 'temp@example.com', 'test-placeholder', 'Тимчасовий')`,
    )
    await client.query(
      `INSERT INTO "Invitation" (id, "inviterId", kind, "tokenHash", "maxUses", "expiresAt")
       VALUES ('i-temp', 'u-temp', 'EMAIL', 'hash-temp', 1, now() + interval '14 days')`,
    )
    await client.query(
      `INSERT INTO "InvitationAcceptance" (id, "invitationId", "userId") VALUES ('a-temp', 'i-temp', 'u-friend')`,
    )

    await client.query(`DELETE FROM "User" WHERE id = 'u-temp'`)

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM "Invitation" UNION ALL SELECT id FROM "InvitationAcceptance" ORDER BY id`,
    )

    expect(rows.map((row) => row.id)).toEqual(['a-1', 'i-1'])
  })

  it('an unknown kind is rejected by the enum', async () => {
    await expect(
      client.query(
        `INSERT INTO "Invitation" (id, "inviterId", kind, "tokenHash", "maxUses", "expiresAt")
         VALUES ('i-x', 'u-owner', 'SMS', 'hash-x', 1, now())`,
      ),
    ).rejects.toMatchObject({ code: '22P02' })
  })
})
