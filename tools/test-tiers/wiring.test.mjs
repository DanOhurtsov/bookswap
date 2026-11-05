import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { API, JEST_SUITES, LEVELS, STEPS, TURBO, stepCommands } from './suites.mjs'

/**
 * How the tiers are wired into the repository: scripts, Jest configs, Turbo, gate.sh and CI. These
 * read the real files — a test or a CI job that silently falls out of every tier fails here.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const json = (path) => JSON.parse(read(path))
const run = (command, args, cwd = ROOT) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function listTests({ dir, config }) {
  return run(
    join(ROOT, dir, 'node_modules/.bin/jest'),
    ['--listTests', ...(config ? ['--config', config] : [])],
    join(ROOT, dir),
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((path) => relative(ROOT, path))
}

describe('scripts', () => {
  const scripts = json('package.json').scripts

  it('pnpm test is Standard; every tier has its own script', () => {
    assert.equal(scripts.test, 'node tools/test-tiers/run.mjs standard')
    assert.equal(scripts['test:standard'], 'node tools/test-tiers/run.mjs standard')
    assert.equal(scripts['test:fast'], 'node tools/test-tiers/run.mjs fast')
    assert.equal(scripts['test:full'], 'node tools/test-tiers/run.mjs full')
  })

  it('cannot recurse: package test scripts run Jest itself, and Turbo has no root test task', () => {
    for (const dir of ['packages/shared', 'apps/web', 'apps/api']) {
      assert.equal(json(`${dir}/package.json`).scripts.test, 'jest', dir)
    }
    assert.doesNotMatch(read('turbo.json'), /"\/\/#test/)
  })

  it('each integration script runs the Jest config its suite declares', () => {
    const api = json('apps/api/package.json').scripts

    assert.match(api['test:e2e'], /--config \.\/test\/jest-e2e\.json$/)
    assert.match(api['test:db-specs'], /--config \.\/test\/jest-db\.json$/)
    assert.match(api['test:browser'], /--config \.\/test\/jest-browser\.json$/)
    assert.equal(api['test:db'], 'pnpm run test:e2e && pnpm run test:db-specs')
  })
})

describe('test inventory', () => {
  const suites = Object.fromEntries(JEST_SUITES.map((suite) => [suite.id, listTests(suite)]))
  const specs = run('git', ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((path) => /[.-]spec\.tsx?$/.test(path))

  it('every spec file of the repository belongs to exactly one suite', () => {
    const owners = new Map(specs.map((path) => [path, []]))

    for (const [id, files] of Object.entries(suites)) {
      for (const file of files) owners.set(file, [...(owners.get(file) ?? []), id])
    }

    const wrong = [...owners].filter(([, ids]) => ids.length !== 1)

    assert.deepEqual(wrong, [], 'файли поза наборами або в кількох наборах')
  })

  it('Standard runs the three unit suites and no integration suite', () => {
    const standard = JEST_SUITES.filter((suite) => LEVELS.standard.includes(suite.step)).map(
      (s) => s.id,
    )

    assert.deepEqual(standard, ['shared', 'web', 'api-unit'])
    for (const id of standard) assert.ok(suites[id].length > 0, id)
    for (const id of ['e2e', 'db', 'browser']) {
      assert.ok(
        suites[id].every((file) => /\.(e2e|db|browser)-spec\.ts$/.test(file)),
        id,
      )
    }
  })

  it('Full runs every suite', () => {
    assert.deepEqual(
      new Set(JEST_SUITES.map((suite) => suite.step).filter((step) => !LEVELS.full.includes(step))),
      new Set(),
    )
  })

  it('Turbo’s test task covers exactly the packages of the unit step', () => {
    const plan = JSON.parse(run(TURBO, ['run', 'test', '--dry=json']))
    const tasks = plan.tasks.filter((task) => task.task === 'test').map((task) => task.package)
    const unitDirs = JEST_SUITES.filter((suite) => suite.step === 'unit').map((suite) => suite.dir)
    const names = unitDirs.map((dir) => json(`${dir}/package.json`).name)

    assert.deepEqual(tasks.sort(), names.sort())
  })
})

describe('database isolation', () => {
  it('refuses a test target equal to the dev database before connecting', () => {
    const api = join(ROOT, 'apps/api')
    const url = 'postgresql://unused:unused@localhost:1/protected_test'
    const result = spawnSync(
      join(api, 'node_modules/.bin/tsx'),
      ['test/db/prepare-tier-database.ts'],
      {
        cwd: api,
        env: {
          ...process.env,
          DATABASE_URL: url,
          DIRECT_DATABASE_URL: url,
          TEST_DATABASE_URL: url,
        },
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /ту саму базу/)
    assert.doesNotMatch(result.stdout, /Seed тестової бази/)
  })

  it('Full prepares the guarded test database instead of deploying or seeding the dev database', () => {
    const commands = stepCommands('db-setup', {
      limits: { jestWorkers: 2, testConcurrency: 1, turboConcurrency: 1 },
      force: true,
      jestArgs: [],
    })

    assert.deepEqual(commands.at(-1).args, ['--filter', API, 'test:prepare-db'])
    assert.ok(
      commands.every(({ args }) => !args.includes('db:deploy') && !args.includes('db:seed')),
    )
  })
})

describe('limits reach Jest', () => {
  it('--maxWorkers on the command line overrides a package config', () => {
    const web = join(ROOT, 'apps/web')
    const config = JSON.parse(
      run(join(web, 'node_modules/.bin/jest'), ['--showConfig', '--maxWorkers=2'], web),
    )

    assert.match(read('apps/web/jest.config.js'), /maxWorkers: 4/)
    assert.equal(config.globalConfig.maxWorkers, 2)
  })
})

describe('gate.sh', () => {
  const gate = (...args) =>
    spawnSync('bash', [join(ROOT, 'gate.sh'), ...args], { encoding: 'utf8' })

  it('fails with a hint on an unknown level or argument, before doing any work', () => {
    for (const args of [['--level', 'quick'], ['--level=quick'], ['--level'], ['quick']]) {
      const result = gate(...args)

      assert.equal(result.status, 2, args.join(' '))
      assert.match(result.stderr, /Використання: \.\/gate\.sh \[--level fast\|standard\|full\]/)
      assert.doesNotMatch(result.stdout, /format:check/)
    }
  })

  it('runs every level through the tier runner, Standard by default', () => {
    const text = read('gate.sh')

    assert.match(text, /^level=standard$/m)
    assert.match(text, /^ {2}fast\) node tools\/test-tiers\/run\.mjs fast ;;$/m)
    assert.match(text, /^ {2}standard\) node tools\/test-tiers\/run\.mjs standard --force ;;$/m)
    assert.match(text, /^ {4}node tools\/test-tiers\/run\.mjs full$/m)
    // Every quality check stays at every level.
    for (const check of [
      'pnpm format:check',
      'run lint typecheck',
      'run build',
      'git diff --check',
      'docs/specification.md',
    ]) {
      assert.ok(text.includes(check), check)
    }
  })
})

describe('CI', () => {
  const ci = read('.github/workflows/ci.yml')
  const jobs = Object.fromEntries(
    ci
      .slice(ci.indexOf('\njobs:'))
      .split(/^ {2}(?=[\w-]+:$)/m)
      .slice(1)
      .map((block) => [block.slice(0, block.indexOf(':')), block]),
  )

  it('runs every Full step, each without Turbo’s cache where it could have one', () => {
    const steps = [...ci.matchAll(/run\.mjs suites ([\w -]+)$/gm)].flatMap((match) =>
      match[1].split(' ').filter((arg) => arg !== '--force'),
    )

    assert.deepEqual(new Set(steps), new Set(STEPS))
    assert.match(ci, /run\.mjs suites unit --force$/m)
  })

  it('the required "Full test suite" job needs every other job and runs even when one fails', () => {
    const full = jobs.full
    const others = Object.keys(jobs).filter((name) => name !== 'full')
    const needs = full
      .match(/needs: \[([^\]]+)\]/)[1]
      .split(',')
      .map((name) => name.trim())

    assert.match(full, /^ {4}name: Full test suite$/m)
    assert.match(full, /^ {4}if: always\(\)$/m)
    assert.deepEqual(needs.sort(), others.sort())
    assert.match(full, /all\(\.value\.result == "success"\)/)
  })

  it('has no path filter that could skip the Full jobs', () => {
    assert.doesNotMatch(ci, /paths(-ignore)?:/)
  })

  it('configures manual runs, read-only permissions, resource limits and bounded job duration', () => {
    assert.match(ci, /^ {2}workflow_dispatch:/m)
    assert.match(ci, /^permissions:\n {2}contents: read$/m)
    assert.match(
      ci,
      /^concurrency:\n {2}group:.*github\.event_name.*\n {2}cancel-in-progress: true$/m,
    )
    assert.match(ci, /^ {2}BOOKSWAP_JEST_WORKERS: '2'$/m)
    assert.match(ci, /^ {2}BOOKSWAP_TEST_CONCURRENCY: '1'$/m)
    assert.match(ci, /^ {2}BOOKSWAP_TURBO_CONCURRENCY: '2'$/m)
    for (const job of Object.values(jobs)) assert.match(job, /^ {4}timeout-minutes: [1-9]\d*$/m)
  })

  const summary = jobs.full
    .split('        run: |\n')[1]
    .trimEnd()
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  const needs = (result, target) =>
    Object.fromEntries(
      ['verify', 'database', 'browser-e2e'].map((name) => [
        name,
        { result: name === target ? result : 'success' },
      ]),
    )
  const checkSummary = (value) =>
    spawnSync('bash', ['-eo', 'pipefail', '-c', summary], {
      env: { ...process.env, NEEDS: JSON.stringify(value) },
      encoding: 'utf8',
    })

  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    it(`Full summary handles ${result} for every prerequisite job`, () => {
      for (const target of ['verify', 'database', 'browser-e2e']) {
        const run = checkSummary(needs(result, target))

        assert.equal(run.status, result === 'success' ? 0 : 1, target + ': ' + run.stderr)
        assert.ok(run.stdout.includes(target + ': ' + result))
      }
    })
  }

  it('Full summary rejects an empty prerequisite set', () => {
    assert.equal(checkSummary({}).status, 1)
  })

  it('bounds Turbo concurrency for every quality task, not only test tasks', () => {
    assert.match(ci, /node tools\/test-tiers\/limits\.mjs turboConcurrency/)
    for (const task of ['lint', 'typecheck', 'build']) {
      assert.match(ci, new RegExp(`pnpm turbo run ${task} --concurrency=`), task)
    }
    assert.doesNotMatch(ci, /^\s*- run: pnpm (lint|typecheck|build)\s*$/m)
  })
})
