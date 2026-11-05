import { fileURLToPath } from 'node:url'

/**
 * Every suite of the repo and the tier that runs it. The single source for `pnpm test:*`, gate.sh and
 * CI: they all call `run.mjs`, and `wiring.test.mjs` checks that CI still covers every Full suite and
 * that every spec file of the repo lands in exactly one Jest suite below.
 */

export const API = '@bookswap/api'
export const WEB = '@bookswap/web'
export const TURBO = fileURLToPath(new URL('../../node_modules/.bin/turbo', import.meta.url))

/** One entry per Jest config. `step` is the `run.mjs suites` step that executes it. */
export const JEST_SUITES = [
  { id: 'shared', step: 'unit', dir: 'packages/shared' },
  { id: 'web', step: 'unit', dir: 'apps/web' },
  { id: 'api-unit', step: 'unit', dir: 'apps/api' },
  { id: 'e2e', step: 'e2e', dir: 'apps/api', config: 'test/jest-e2e.json' },
  { id: 'db', step: 'db', dir: 'apps/api', config: 'test/jest-db.json' },
  { id: 'browser', step: 'browser', dir: 'apps/api', config: 'test/jest-browser.json' },
]

/** Suites Fast never runs, with the packages whose code they execute (browser specs spawn `next dev`). */
export const INTEGRATION = [
  { id: 'e2e', packages: [API] },
  { id: 'db', packages: [API] },
  { id: 'browser', packages: [API, WEB] },
]

/** Order matters: unit before anything that needs PostgreSQL, the browser last — it is the heaviest. */
export const STEPS = ['unit', 'db-setup', 'e2e', 'db', 'browser']

export const LEVELS = {
  standard: ['unit'],
  full: STEPS,
}

const turbo = (args) => ({ command: TURBO, args })
const pnpm = (args) => ({ command: 'pnpm', args })

/**
 * The commands of one step. Unit specs run through Turbo's `test` task (one package at a time by
 * default, each Jest bounded by `--maxWorkers`); integration specs keep `maxWorkers: 1` from their
 * own configs — they share one database and must stay serial.
 *
 * @param {string} step
 * @param {{ limits: { jestWorkers: number, testConcurrency: number, turboConcurrency: number },
 *   force: boolean, jestArgs: string[] }} options
 */
export function stepCommands(step, { limits, force, jestArgs }) {
  const concurrency = `--concurrency=${limits.turboConcurrency}`

  switch (step) {
    case 'unit':
      return [
        {
          title: 'Unit: Shared, Web, API',
          ...turbo([
            'run',
            'test',
            `--concurrency=${limits.testConcurrency}`,
            ...(force ? ['--force'] : []),
            '--',
            `--maxWorkers=${limits.jestWorkers}`,
            ...jestArgs,
          ]),
        },
        {
          title: 'Unit: інструменти рівнів тестування',
          command: process.execPath,
          args: ['--test', '--test-reporter=spec', 'tools/test-tiers/*.test.mjs'],
        },
      ]
    case 'db-setup':
      // Reuse the existing fail-closed test-database guard before migration or seed can connect.
      return [
        { title: 'Prisma Client', ...turbo(['run', 'generate', `--filter=${API}`, concurrency]) },
        { title: 'Залежності API', ...turbo(['run', 'build', `--filter=${API}^...`, concurrency]) },
        { title: 'Міграції та seed тестової бази', ...pnpm(['--filter', API, 'test:prepare-db']) },
      ]
    case 'e2e':
      return [{ title: 'E2E', ...turbo(['run', 'test:e2e', `--filter=${API}`, concurrency]) }]
    case 'db':
      return [{ title: 'DB', ...turbo(['run', 'test:db-specs', `--filter=${API}`, concurrency]) }]
    case 'browser':
      return [
        { title: 'Browser', ...turbo(['run', 'test:browser', `--filter=${API}`, concurrency]) },
      ]
    default:
      throw new Error(`unknown step "${step}"`)
  }
}
