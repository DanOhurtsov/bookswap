#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planFast, readsFilesystem } from './fast-plan.mjs'
import { describeLimits, LimitError, resolveLimits } from './limits.mjs'
import { collectChanges, readWorkspace, resolveBase } from './repo.mjs'
import { INTEGRATION, LEVELS, STEPS, TURBO, stepCommands } from './suites.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

const USAGE = `Використання:
  run.mjs fast      [--base <ref>] [--dry-run] [-- <аргументи Jest>]
  run.mjs standard  [--force] [--dry-run] [-- <аргументи Jest>]
  run.mjs full      [--dry-run]
  run.mjs suites    <${STEPS.join('|')}>... [--force] [--dry-run]

Рівні: fast — unit-тести, яких торкаються зміни; standard — усі unit-тести (Shared, Web, API);
full — усе: unit, E2E, DB, browser. Деталі — docs/plan/bs-152-three-tier-testing.md.`

export class UsageError extends Error {}

/** @returns {{ level: string, steps: string[], force: boolean, dryRun: boolean, base?: string, jestArgs: string[] }} */
export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const jestArgs = separator === -1 ? [] : argv.slice(separator + 1)
  const [level, ...rest] = own
  const options = { level, steps: [], force: false, dryRun: false, base: undefined, jestArgs }

  if (!['fast', 'standard', 'full', 'suites'].includes(level)) {
    throw new UsageError(level === undefined ? 'не вказано рівень' : `невідомий рівень "${level}"`)
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]

    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force' && level !== 'fast') options.force = true
    else if (arg === '--base' && level === 'fast' && rest[i + 1] !== undefined)
      options.base = rest[++i]
    else if (level === 'suites' && STEPS.includes(arg)) options.steps.push(arg)
    else throw new UsageError(`невідомий аргумент "${arg}" для рівня ${level}`)
  }

  if (level === 'suites' && options.steps.length === 0)
    throw new UsageError('не вказано жодного кроку')
  if (jestArgs.length > 0 && !['fast', 'standard'].includes(level)) {
    throw new UsageError(`рівень ${level} не приймає аргументів Jest`)
  }

  return options
}

const log = (line) => process.stdout.write(`[test-tiers] ${line}\n`)

/**
 * Runs the steps one after another and stops at the first failure — whose exit code becomes the
 * runner's, and whose skipped successors are listed, so a partial run never reads as a green one.
 */
export function runSteps(steps, { dryRun, cwd = ROOT, report = log }) {
  const done = []

  for (const [index, step] of steps.entries()) {
    report(`▶ ${step.title}: ${[step.command, ...step.args].join(' ')}`)
    if (dryRun) continue

    const started = Date.now()
    const result = spawnSync(step.command, step.args, { cwd: step.cwd ?? cwd, stdio: 'inherit' })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const code = result.error !== undefined ? 1 : (result.status ?? 1)

    if (code !== 0) {
      const reason = result.error?.message ?? result.signal ?? `код ${String(result.status)}`

      report(`✗ ${step.title} — ${reason} (${seconds} с)`)
      for (const skipped of steps.slice(index + 1)) report(`  не виконано: ${skipped.title}`)

      return code
    }

    done.push(`${step.title} (${seconds} с)`)
  }

  if (!dryRun) for (const line of done) report(`✓ ${line}`)

  return 0
}

function jest(dir, args) {
  return { command: join(ROOT, dir, 'node_modules/.bin/jest'), args, cwd: join(ROOT, dir) }
}

function listTests(dir, args) {
  const output = execFileSync(join(ROOT, dir, 'node_modules/.bin/jest'), ['--listTests', ...args], {
    cwd: join(ROOT, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return output.split('\n').filter((line) => line.trim() !== '')
}

/** The tests Fast runs for one package in `related` mode. */
function relatedTests(pkg) {
  const related = listTests(pkg.dir, [
    '--findRelatedTests',
    ...pkg.files.map((file) => join(ROOT, file)),
  ])
  const filesystem = listTests(pkg.dir, []).filter((path) =>
    readsFilesystem(readFileSync(path, 'utf8')),
  )

  return { tests: [...new Set([...related, ...filesystem])].sort(), filesystem: filesystem.length }
}

/** Standard's unit step, announced as the conservative fallback it is. */
function widenToStandard(reason, options, limits) {
  log(`Fast розширено до Standard: ${reason}`)

  return stepCommands('unit', { limits, force: false, jestArgs: options.jestArgs })
}

function fastSteps(options, limits) {
  const explicit = options.base ?? (process.env.BOOKSWAP_TEST_BASE || undefined)
  let base

  try {
    base = resolveBase(ROOT, explicit)
  } catch (error) {
    // An explicit base is a request: a typo in it must not quietly turn into a different run.
    if (explicit !== undefined) throw new UsageError(error.message)

    return widenToStandard(error.message, options, limits)
  }

  let workspace
  let plan

  try {
    workspace = readWorkspace(ROOT)
    plan = planFast(collectChanges(ROOT, base.mergeBase), workspace)
  } catch (error) {
    return widenToStandard(`аналіз змін не вдався: ${error.message}`, options, limits)
  }

  log(
    `База: ${base.ref}, merge-base ${base.mergeBase.slice(0, 12)} (+ staged, unstaged, untracked)`,
  )
  if (plan.ignored.length > 0)
    log(`Без впливу на тести: ${plan.ignored.length} файл(ів) документації`)
  if (plan.mode === 'standard') return widenToStandard(plan.reason, options, limits)

  const steps = []
  const workers = `--maxWorkers=${limits.jestWorkers}`

  for (const pkg of plan.packages) {
    if (pkg.full) {
      log(`${pkg.name}: увесь набір — ${pkg.reasons.join('; ')}`)
      steps.push({
        title: `Unit ${pkg.name} (увесь)`,
        ...jest(pkg.dir, [workers, ...options.jestArgs]),
      })
      continue
    }

    let selected

    try {
      selected = relatedTests(pkg)
    } catch (error) {
      return widenToStandard(
        `Jest не визначив пов'язані тести ${pkg.name}: ${error.message}`,
        options,
        limits,
      )
    }

    log(
      `${pkg.name}: ${selected.tests.length} файл(ів) — пов'язані зі змінами в ${pkg.files.length} ` +
        `файлі(ах) + ${selected.filesystem} тест(ів), що читають файли напряму`,
    )
    for (const test of selected.tests) log(`  ${relative(ROOT, test)}`)
    if (selected.tests.length > 0) {
      steps.push({
        title: `Unit ${pkg.name} (${selected.tests.length} файл(ів))`,
        ...jest(pkg.dir, [workers, ...options.jestArgs, '--runTestsByPath', ...selected.tests]),
      })
    }
  }

  if (steps.length === 0) log('Жоден unit-тест не залежить від цих змін.')
  if (plan.integration.length > 0) {
    log(
      `НЕ запускаються на рівні Fast, хоча зміни можуть на них впливати: ${plan.integration.join(', ')} ` +
        '— перевіряються в pnpm test:full і в CI.',
    )
  }

  // Consumers test against their dependencies' build output and the generated Prisma Client.
  const selected = workspace.packages.filter((pkg) =>
    plan.packages.some((p) => p.name === pkg.name),
  )
  const prerequisites = []
  const concurrency = `--concurrency=${limits.turboConcurrency}`
  const withDeps = selected.filter((pkg) => pkg.deps.length > 0)
  const withGenerate = selected.filter((pkg) => pkg.hasGenerate)

  if (withDeps.length > 0) {
    prerequisites.push({
      title: 'Збірка залежностей',
      command: TURBO,
      args: ['run', 'build', concurrency, ...withDeps.map((pkg) => `--filter=${pkg.name}^...`)],
    })
  }
  if (withGenerate.length > 0) {
    prerequisites.push({
      title: 'Prisma Client',
      command: TURBO,
      args: ['run', 'generate', concurrency, ...withGenerate.map((pkg) => `--filter=${pkg.name}`)],
    })
  }

  return steps.length === 0 ? [] : [...prerequisites, ...steps]
}

export function main(argv) {
  let options
  let limits

  try {
    options = parseArgs(argv)
    limits = resolveLimits(process.env, availableParallelism())
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof LimitError)) throw error
    process.stderr.write(`test-tiers: ${error.message}\n\n${USAGE}\n`)

    return 2
  }

  log(`Рівень: ${options.level}${options.steps.length > 0 ? ` (${options.steps.join(', ')})` : ''}`)
  log(describeLimits(limits))

  let steps

  try {
    if (options.level === 'fast') {
      steps = fastSteps(options, limits)
    } else {
      const names =
        options.level === 'suites'
          ? STEPS.filter((s) => options.steps.includes(s))
          : LEVELS[options.level]
      // Full never replays Turbo's cache: it is the run that has to prove the tests pass now.
      const force = options.force || options.level === 'full'

      steps = names.flatMap((name) =>
        stepCommands(name, { limits, force, jestArgs: options.jestArgs }),
      )
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`test-tiers: ${error.message}\n`)

    return 2
  }

  const code = runSteps(steps, options)

  if (code === 0 && options.level === 'standard' && !options.dryRun) {
    log(
      `Standard пройшов. Не входять у рівень: ${INTEGRATION.map((s) => s.id).join(', ')} — pnpm test:full.`,
    )
  }

  return code
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
