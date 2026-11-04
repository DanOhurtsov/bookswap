import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LimitError, resolveLimits } from './limits.mjs'

describe('resolveLimits', () => {
  it('defaults: 4 workers, one package at a time, Turbo concurrency 2', () => {
    assert.deepEqual(resolveLimits({}, 16), {
      jestWorkers: 4,
      testConcurrency: 1,
      turboConcurrency: 2,
    })
  })

  it('never defaults to more workers than cores - 1, nor fewer than 1', () => {
    assert.equal(resolveLimits({}, 2).jestWorkers, 1)
    assert.equal(resolveLimits({}, 1).jestWorkers, 1)
    assert.equal(resolveLimits({}, 1).turboConcurrency, 1)
  })

  it('takes valid values from the environment; empty means unset', () => {
    const env = {
      BOOKSWAP_JEST_WORKERS: '2',
      BOOKSWAP_TEST_CONCURRENCY: '3',
      BOOKSWAP_TURBO_CONCURRENCY: '',
    }

    assert.deepEqual(resolveLimits(env, 8), {
      jestWorkers: 2,
      testConcurrency: 3,
      turboConcurrency: 2,
    })
  })

  it('rejects anything but a positive integer', () => {
    for (const value of ['0', '-1', '1.5', 'abc', ' 2', '50%']) {
      assert.throws(() => resolveLimits({ BOOKSWAP_JEST_WORKERS: value }, 16), LimitError, value)
    }
  })

  it('rejects a value above the CPU count', () => {
    assert.throws(
      () => resolveLimits({ BOOKSWAP_TURBO_CONCURRENCY: '9' }, 8),
      /більше за кількість/,
    )
  })

  it('bounds the total: workers × concurrent packages', () => {
    assert.throws(
      () => resolveLimits({ BOOKSWAP_JEST_WORKERS: '4', BOOKSWAP_TEST_CONCURRENCY: '3' }, 8),
      /= 12 одночасних/,
    )
  })
})

describe('limits.mjs as a command (gate.sh)', () => {
  const script = fileURLToPath(new URL('./limits.mjs', import.meta.url))

  it('prints one validated value', () => {
    const output = execFileSync(process.execPath, [script, 'turboConcurrency'], {
      env: { ...process.env, BOOKSWAP_TURBO_CONCURRENCY: '1' },
      encoding: 'utf8',
    })

    assert.equal(output, '1\n')
  })

  it('exits non-zero on an invalid value', () => {
    const result = spawnSync(process.execPath, [script, 'turboConcurrency'], {
      env: { ...process.env, BOOKSWAP_TURBO_CONCURRENCY: 'many' },
      encoding: 'utf8',
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /BOOKSWAP_TURBO_CONCURRENCY/)
  })
})
