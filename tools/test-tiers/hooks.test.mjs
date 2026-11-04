import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installHooks } from './install-hooks.mjs'

// A hook may export GIT_DIR/GIT_INDEX_FILE; fixtures must never inherit the real repository.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'bookswap-hooks-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  try {
    git('init', '--quiet')
    mkdirSync(join(root, '.githooks'))
    copyFileSync(
      fileURLToPath(new URL('../../.githooks/pre-commit', import.meta.url)),
      join(root, '.githooks/pre-commit'),
    )
    run({ root, git })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('installs the versioned hook locally and is idempotent', () => {
  fixture(({ root, git }) => {
    installHooks(root)
    installHooks(root)
    assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.githooks')
  })
})

it('preserves an existing hooks path', () => {
  fixture(({ root, git }) => {
    git('config', '--local', 'core.hooksPath', '.custom-hooks')
    assert.throws(() => installHooks(root), /автоматичну заміну заборонено/)
    assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.custom-hooks')
  })
})

it('preserves an existing local pre-commit hook', () => {
  fixture(({ root }) => {
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n')
    assert.throws(() => installHooks(root), /Уже існує локальний pre-commit/)
  })
})

it('pre-commit runs Standard without the Turbo cache and propagates failure', () => {
  fixture(({ root }) => {
    installHooks(root)
    mkdirSync(join(root, 'bin'))
    const pnpm = join(root, 'bin/pnpm')
    writeFileSync(pnpm, '#!/bin/sh\nprintf "%s\\n" "$*"\nexit 3\n')
    chmodSync(pnpm, 0o755)
    const result = spawnSync('git', ['hook', 'run', 'pre-commit'], {
      cwd: root,
      env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH },
      encoding: 'utf8',
    })

    assert.equal(result.status, 3)
    assert.match(result.stdout + result.stderr, /test:standard --force/)
  })
})
