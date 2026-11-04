import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import globalSetup from './global-setup'
import { testDatabaseUrl } from './test-database'

/**
 * Full's migration and seed smoke check. The existing setup validates the original environment
 * before connecting, recreates only the guarded local _test database, and migrates it from empty.
 * Each seed CLI receives the test URL explicitly; dotenv cannot redirect it to the dev database.
 * Integration suites recreate the same database afterwards, so seed data never leaks into them.
 */
async function prepareTierDatabase(): Promise<void> {
  await globalSetup()

  const url = testDatabaseUrl()

  for (const attempt of [1, 2]) {
    process.stdout.write(`[test-tiers] Seed тестової бази (${String(attempt)}/2)\n`)
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'seed'], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      stdio: 'inherit',
    })
  }
}

void prepareTierDatabase().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'підготовка тестової бази не пройшла'

  process.stderr.write(`test-tiers: ${message}\n`)
  process.exitCode = 1
})
