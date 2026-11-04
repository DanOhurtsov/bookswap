import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, runSteps, UsageError } from './run.mjs'

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url))

function dryRun(args, env = {}) {
  return spawnSync(process.execPath, [RUN, ...args, '--dry-run'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

describe('parseArgs', () => {
  it('accepts every level with its own options', () => {
    assert.equal(parseArgs(['fast', '--base', 'origin/dev']).base, 'origin/dev')
    assert.equal(parseArgs(['standard', '--force']).force, true)
    assert.deepEqual(parseArgs(['standard', '--', '--coverage']).jestArgs, ['--coverage'])
    assert.deepEqual(parseArgs(['suites', 'e2e', 'db']).steps, ['e2e', 'db'])
  })

  it('rejects an unknown or missing level, unknown options and misplaced ones', () => {
    for (const argv of [
      [],
      ['quick'],
      ['standard', '--fast'],
      ['fast', '--force'],
      ['fast', '--base'],
      ['full', '--', '--coverage'],
      ['suites'],
      ['suites', 'lint'],
    ]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(' '))
    }
  })
})

describe('runSteps', () => {
  const quiet = { dryRun: false, report: () => {} }
  const node = (code) => ({ title: code, command: process.execPath, args: ['-e', code] })

  it('returns the failing step’s exit code and runs nothing after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-tiers-'))
    const marker = join(dir, 'ran')

    try {
      const code = runSteps(
        [
          node(''),
          node('process.exit(3)'),
          node(`require('fs').writeFileSync(${JSON.stringify(marker)}, '')`),
        ],
        quiet,
      )

      assert.equal(code, 3)
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a step killed by a signal or one that cannot start is a failure', () => {
    assert.equal(runSteps([node("process.kill(process.pid, 'SIGKILL')")], quiet), 1)
    assert.equal(runSteps([{ title: 'missing', command: '/nonexistent/bin', args: [] }], quiet), 1)
  })

  it('passes when every step passes', () => {
    assert.equal(runSteps([node(''), node('')], quiet), 0)
  })
})

describe('run.mjs as a command', () => {
  it('exits 2 with the usage on an unknown level', () => {
    const result = spawnSync(process.execPath, [RUN, 'quick'], { encoding: 'utf8' })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /невідомий рівень "quick"/)
    assert.match(result.stderr, /run\.mjs standard/)
  })

  it('exits 2 on an invalid limit before running anything', () => {
    const result = dryRun(['standard'], { BOOKSWAP_JEST_WORKERS: '0' })

    assert.equal(result.status, 2)
    assert.doesNotMatch(result.stdout, /▶/)
  })

  it('applies the configured limits to the commands it runs', () => {
    const result = dryRun(['full'], {
      BOOKSWAP_JEST_WORKERS: '2',
      BOOKSWAP_TEST_CONCURRENCY: '3',
      BOOKSWAP_TURBO_CONCURRENCY: '1',
    })
    const unit = result.stdout.split('\n').find((line) => line.includes('run test '))

    assert.equal(result.status, 0)
    assert.match(unit, /--concurrency=3 --force -- --maxWorkers=2$/)
    for (const task of ['test:e2e', 'test:db-specs', 'test:browser']) {
      assert.match(result.stdout, new RegExp(`run ${task} --filter=@bookswap/api --concurrency=1`))
    }
  })

  it('Standard is the unit step only; Full is unit, database setup, E2E, DB and browser in that order', () => {
    const titles = (args) =>
      dryRun(args)
        .stdout.split('\n')
        .filter((line) => line.includes('▶'))
        .map((line) => line.replace(/^.*▶ ([^:]+):.*$/, '$1'))

    assert.deepEqual(titles(['standard']), ['Unit', 'Unit'])
    assert.deepEqual(titles(['full']), [
      'Unit',
      'Unit',
      'Prisma Client',
      'Залежності API',
      'Міграції та seed тестової бази',
      'E2E',
      'DB',
      'Browser',
    ])
  })
})
