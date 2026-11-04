import { availableParallelism } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * Resource limits for every test and Turbo run. Memory, not cores, is what runs out: each ts-jest
 * worker holds its own TypeScript program (plus jsdom in web, ~330 MB). Several packages running at
 * once multiply that — 3 packages × 15 default workers exhausted RAM and swap on a 10 GB WSL — so
 * workers and package concurrency are bounded together, not one at a time.
 */
export const LIMIT_VARIABLES = {
  jestWorkers: 'BOOKSWAP_JEST_WORKERS',
  testConcurrency: 'BOOKSWAP_TEST_CONCURRENCY',
  turboConcurrency: 'BOOKSWAP_TURBO_CONCURRENCY',
}

export class LimitError extends Error {}

export function defaultLimits(cpus) {
  return {
    // web measured 4 workers as the fastest setting that stays in RAM next to the dev servers.
    jestWorkers: Math.min(4, Math.max(1, cpus - 1)),
    // One package's unit suite at a time: the worker budget above is per package.
    testConcurrency: 1,
    // lint + typecheck at Turbo's default (10) peaked at ~3.6 GB summed PSS on that machine.
    turboConcurrency: Math.min(2, cpus),
  }
}

/** Reads the limits from `env`; throws `LimitError` on anything that is not a usable value. */
export function resolveLimits(env, cpus) {
  const limits = defaultLimits(cpus)

  for (const [key, name] of Object.entries(LIMIT_VARIABLES)) {
    const raw = env[name]

    if (raw === undefined || raw === '') continue
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new LimitError(`${name} має бути цілим числом ≥ 1, отримано "${raw}"`)
    }

    const value = Number(raw)

    if (value > cpus) {
      throw new LimitError(`${name}=${value} більше за кількість доступних CPU (${cpus})`)
    }

    limits[key] = value
  }

  const total = limits.jestWorkers * limits.testConcurrency

  if (total > cpus) {
    throw new LimitError(
      `${LIMIT_VARIABLES.jestWorkers} × ${LIMIT_VARIABLES.testConcurrency} = ${total} одночасних ` +
        `Jest-воркерів, більше за кількість CPU (${cpus})`,
    )
  }

  return limits
}

export function describeLimits(limits) {
  return (
    `Jest workers на пакет: ${limits.jestWorkers}; пакетів одночасно: ${limits.testConcurrency} ` +
    `(разом до ${limits.jestWorkers * limits.testConcurrency} воркерів); ` +
    `Turbo concurrency для lint/typecheck/build: ${limits.turboConcurrency}`
  )
}

// `node limits.mjs <key>` prints one validated value — gate.sh reads the Turbo concurrency this way,
// so the shell never re-implements the validation.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = process.argv[2]

  try {
    const limits = resolveLimits(process.env, availableParallelism())

    if (!(key in limits)) throw new LimitError(`невідомий ключ "${key}"`)
    process.stdout.write(`${String(limits[key])}\n`)
  } catch (error) {
    process.stderr.write(`limits: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}
