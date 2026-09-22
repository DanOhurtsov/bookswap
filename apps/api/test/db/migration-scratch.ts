import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { assertSafeScratchDatabase, type DatabaseTarget, type ProtectedTarget } from './guard'
import {
  maintenanceUrl,
  originalDatabaseUrl,
  originalDirectDatabaseUrl,
  testDatabaseName,
  testDatabaseUrl,
} from './test-database'

/**
 * Stage 8e-1 (docs/plan/stage-8-inventory.md, §5): a second, disposable database
 * for the migration-replay tests — the ones that need to stop partway through
 * the real migration history (old schema, then the additive migration, then
 * the required one) rather than the fully-migrated state every other
 * `*.db-spec.ts` file runs against.
 *
 * It is deliberately NOT the shared `_test` database `global-setup.ts` already
 * prepared for the rest of the suite: that database is recreated once per
 * `test:db` run and every other file assumes it is already on the final
 * schema. This module gives each run its own database instead, and the
 * lifecycle is deliberately narrow:
 *
 * - the name is unique to THIS run (`generateRunId()`), not just to a `key` —
 *   two runs (retried CI, a leftover process, two workers) never contend for
 *   the same physical database;
 * - `CREATE DATABASE` is never preceded by a `DROP` — there is nothing to
 *   drop before creating a name nobody has used yet, and a create that fails
 *   because the name is somehow already taken means that database belongs to
 *   someone/something else, not this run;
 * - a failed create returns no handle — there is no `cleanup()` to call, so
 *   there is no path from "setup failed" to "delete a database we didn't
 *   create";
 * - every target still goes through `assertSafeScratchDatabase` (`guard.ts`):
 *   the dev database, its direct-connection counterpart (read
 *   pre-substitution, not from `process.env`), the shared test database,
 *   PostgreSQL's reserved databases, and the server's 63-byte identifier
 *   limit — all against the fully normalized target, never a name/substring
 *   comparison.
 */

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations')

/**
 * An explicit budget for `afterAll(() => scratch.cleanup())` — and for nothing
 * else. Jest takes it as the second argument: `afterAll(callback, timeout)`.
 *
 * `cleanup()` asserts nothing. It closes the client to the scratch database,
 * opens a separate maintenance connection and runs
 * `DROP DATABASE … WITH (FORCE)`. Those are three operations of a real
 * PostgreSQL server rather than computation in memory, and none of them has a
 * guaranteed upper bound on a loaded machine.
 *
 * Why this is not a way to hide a failure: the timeout sits on a teardown hook,
 * where there is no `expect`. It neither defers nor softens a failed assertion
 * inside an `it(...)` — it does not apply to the tests at all. The global
 * `testTimeout` in `jest-db.json` is deliberately NOT raised: a test that hangs
 * must still fail at five seconds.
 *
 * A precondition, verified separately: every `*.db-spec.ts` that opens its own
 * `Client`/`PrismaClient` against the scratch database closes it in a `finally`
 * BEFORE `cleanup()` runs. `WITH (FORCE)` here guards against somebody else's
 * connection; it is not permission to leave our own open.
 *
 * 15 seconds is the same value `jest-e2e.json` already sets as its
 * `testTimeout`, for the same reason: `gate.sh` runs lint, typecheck, build and
 * seed before this, so the machine underneath is not idle.
 */
export const SCRATCH_CLEANUP_TIMEOUT_MS = 15_000

const DEFAULT_KEY = 'default'
const KEY_PATTERN = /^[a-z0-9_]+$/
const RUN_ID_PATTERN = /^[a-z0-9]+$/

/**
 * A short, high-entropy-enough token unique to one `createScratchDatabase`
 * call: current time (base36) plus 3 random bytes (hex). Not a UUID — this
 * has to fit a PostgreSQL identifier alongside the rest of the name within
 * 63 bytes, and only needs to be unlikely to collide within one test run,
 * not globally unique forever.
 */
function generateRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

/**
 * Pure name construction — no I/O, no safety check. Both `key` (a human
 * label — which suite owns this database) and `runId` (uniqueness) are
 * required: a name built from `key` alone is exactly what let two runs
 * collide on one database before. The actual safety property (this name
 * provably isn't the dev database, the shared test database, a reserved
 * database, or too long for PostgreSQL to store without truncating) is
 * `assertSafeScratchDatabase` (`guard.ts`), applied in
 * `createScratchDatabaseUsing` below — never call `CREATE`/`DROP` off a name
 * this function returned without going through that check first.
 */
export function scratchDatabaseName(key: string, runId: string): string {
  const base = testDatabaseName()

  if (!/^[A-Za-z0-9_]+_test$/.test(base)) {
    // Belt-and-braces: `testDatabaseName()` is already validated by
    // `assertSafeTestDatabase` to match this shape. If that ever changes,
    // fail loudly here rather than derive a scratch name from something
    // unverified.
    throw new Error(`Unexpected TEST_DATABASE_URL database name shape: ${base}`)
  }

  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Scratch database key "${key}" must match ${KEY_PATTERN.source}`)
  }

  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Scratch database run id "${runId}" must match ${RUN_ID_PATTERN.source}`)
  }

  return base.replace(/_test$/, `_migration_scratch_${key}_${runId}_test`)
}

function scratchDatabaseUrl(name: string): string {
  const url = new URL(testDatabaseUrl())

  url.pathname = `/${name}`

  return url.toString()
}

/**
 * The databases a scratch target must never resolve to. `DATABASE_URL`/
 * `DIRECT_DATABASE_URL` are read via `originalDatabaseUrl()`/
 * `originalDirectDatabaseUrl()` — the values captured before
 * `use-test-database.ts` substitutes `process.env` for the test run — not
 * `process.env` directly, which by the time any `*.db-spec.ts` file's own
 * code runs already holds the substituted (test database) values and could
 * no longer catch a real collision with the dev database.
 */
function protectedTargets(): ProtectedTarget[] {
  return [
    { label: 'DATABASE_URL (dev, pre-test-substitution)', url: originalDatabaseUrl() },
    { label: 'DIRECT_DATABASE_URL (dev, pre-test-substitution)', url: originalDirectDatabaseUrl() },
    { label: 'TEST_DATABASE_URL (shared)', url: testDatabaseUrl() },
  ]
}

/**
 * The one gate every target this module touches goes through. Re-parses and
 * re-normalizes the candidate (not a string/substring check) against the dev
 * database, its direct counterpart, the shared test database, every
 * PostgreSQL reserved database, and the server's identifier length limit —
 * see `assertSafeScratchDatabase` (`guard.ts`) for what each of those catches.
 */
function assertSafeScratchTarget(name: string): DatabaseTarget {
  return assertSafeScratchDatabase(
    scratchDatabaseUrl(name),
    `scratch database "${name}"`,
    protectedTargets(),
  )
}

/** The minimal shape `createScratchDatabaseUsing` needs from a connection — real `pg.Client` satisfies it. */
export interface SqlExecutor {
  query(text: string): Promise<unknown>
}

export interface ScratchDatabaseHandle {
  target: DatabaseTarget
  /**
   * Drops the database — but ONLY the one THIS handle's own `CREATE`
   * succeeded on, and only once: a second call is a no-op, not a second
   * `DROP`. Takes its own executor (rather than closing over the one passed
   * to `createScratchDatabaseUsing`) so a caller can use a short-lived
   * connection for create and a separate one for cleanup, which is how
   * `createScratchDatabase` below actually uses it.
   */
  cleanup(admin: SqlExecutor): Promise<void>
}

/**
 * The actual lifecycle, parameterized over `admin` — not a real `pg.Client`
 * directly — so `migration-scratch.spec.ts` can drive it with a mock SQL
 * recorder and prove the create/no-drop rules without a live Postgres
 * connection:
 *
 * - no `DROP` before `CREATE` — the name is fresh, there is nothing to drop;
 * - `CREATE` failing (name collision, permission error, anything) rejects
 *   this call and returns no handle — there is no `cleanup()` reachable for
 *   a database this run never actually created, and nothing here ever
 *   attempts a `DROP` in that path;
 * - the returned handle's `cleanup` only ever targets the exact name this
 *   call itself validated and created, and only while it still "owns" it.
 */
export async function createScratchDatabaseUsing(
  admin: SqlExecutor,
  key: string = DEFAULT_KEY,
  runId: string = generateRunId(),
): Promise<ScratchDatabaseHandle> {
  const name = scratchDatabaseName(key, runId)
  const target = assertSafeScratchTarget(name)

  try {
    await admin.query(`CREATE DATABASE "${target.database}"`)
  } catch (error) {
    throw new Error(
      `Failed to create scratch database "${target.database}" (key="${key}") — refusing to drop ` +
        'anything: a name collision here means something else already owns it, not this run.',
      { cause: error },
    )
  }

  let owned = true

  return {
    target,
    async cleanup(cleanupAdmin: SqlExecutor) {
      if (!owned) return

      owned = false
      await cleanupAdmin.query(`DROP DATABASE IF EXISTS "${target.database}" WITH (FORCE)`)
    },
  }
}

async function withMaintenanceClient<T>(run: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: maintenanceUrl() })

  await admin.connect()

  try {
    return await run(admin)
  } finally {
    await admin.end()
  }
}

export interface ScratchDatabase {
  client: Client
  target: DatabaseTarget
  /** Connection string to this scratch database — for building an additional connection (e.g. a `PrismaClient`) against the same database. */
  url: string
  /** Closes the scratch client, then drops the database — only if it was this run's own `createScratchDatabase` that created it. */
  cleanup(): Promise<void>
}

/**
 * Creates a fresh, uniquely-named scratch database for one test run and
 * returns an already-connected client to it, plus a `cleanup()` that tears
 * both down. See `createScratchDatabaseUsing` above for the create/no-drop
 * lifecycle rules this wraps with real connections.
 */
export async function createScratchDatabase(key: string = DEFAULT_KEY): Promise<ScratchDatabase> {
  const handle = await withMaintenanceClient((admin) => createScratchDatabaseUsing(admin, key))
  const url = scratchDatabaseUrl(handle.target.database)

  const client = new Client({ connectionString: url })

  await client.connect()

  return {
    client,
    target: handle.target,
    url,
    async cleanup() {
      await client.end()
      await withMaintenanceClient((admin) => handle.cleanup(admin))
    },
  }
}

/** Migration folder names, chronological (timestamp-prefixed) order — the real thing on disk. */
export function listMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function readMigrationSql(dirName: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dirName, 'migration.sql'), 'utf8')
}

/** Applies one migration's real `migration.sql`, unmodified, via a plain multi-statement query. */
export async function applyMigration(client: Client, dirName: string): Promise<void> {
  await client.query(readMigrationSql(dirName))
}

export async function applyMigrations(client: Client, dirNames: string[]): Promise<void> {
  for (const dirName of dirNames) {
    await applyMigration(client, dirName)
  }
}
