import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { collectChanges, parseJsonc, resolveBase } from './repo.mjs'

// A scratch repository per suite. GIT_* variables are dropped from this test process (node --test
// runs each file in its own): under a git hook they point at the real repository, and neither these
// commands nor the ones in repo.mjs may touch it.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'test-tiers-'))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const write = (path, text) => writeFileSync(join(dir, path), text)

  git('init', '--quiet', '--initial-branch=main')

  return { dir, git, write }
}

describe('collectChanges against the merge-base', () => {
  let repo
  let base

  before(() => {
    repo = scratchRepo()
    for (const name of ['kept', 'edited', 'staged', 'deleted', 'renamed'])
      repo.write(`${name}.ts`, `${name}\n`)
    repo.git('add', '.')
    repo.git('commit', '--quiet', '-m', 'base')
    repo.git('switch', '--quiet', '-c', 'feature')
    repo.write('committed.ts', 'on the branch\n')
    repo.git('add', '.')
    repo.git('commit', '--quiet', '-m', 'branch work')
    // main moves on after the branch point: none of this is the branch's change.
    repo.git('switch', '--quiet', 'main')
    repo.write('later-on-main.ts', 'x\n')
    repo.git('add', '.')
    repo.git('commit', '--quiet', '-m', 'main moves')
    repo.git('switch', '--quiet', 'feature')

    repo.write('edited.ts', 'unstaged edit\n')
    repo.write('staged.ts', 'staged edit\n')
    repo.git('add', 'staged.ts')
    unlinkSync(join(repo.dir, 'deleted.ts'))
    repo.git('mv', 'renamed.ts', 'renamed-to.ts')
    repo.write('untracked.ts', 'new\n')

    base = resolveBase(repo.dir, undefined)
  })

  after(() => rmSync(repo.dir, { recursive: true, force: true }))

  it('resolves the default base to the merge-base, not to main’s tip', () => {
    assert.equal(base.ref, 'main')
    assert.equal(base.mergeBase, repo.git('rev-parse', 'main~1').trim())
  })

  it('sees committed, staged, unstaged, deleted, renamed and untracked files — and nothing else', () => {
    const changes = collectChanges(repo.dir, base.mergeBase).sort((a, b) =>
      a.path.localeCompare(b.path),
    )

    assert.deepEqual(changes, [
      { status: 'A', path: 'committed.ts' },
      { status: 'D', path: 'deleted.ts' },
      { status: 'M', path: 'edited.ts' },
      { status: 'A', path: 'renamed-to.ts' },
      { status: 'D', path: 'renamed.ts' },
      { status: 'M', path: 'staged.ts' },
      { status: 'A', path: 'untracked.ts' },
    ])
  })
})

describe('resolveBase failures', () => {
  let repo

  before(() => {
    repo = scratchRepo()
    repo.write('a.ts', 'a\n')
    repo.git('add', '.')
    repo.git('commit', '--quiet', '-m', 'a')
    repo.git('branch', '-m', 'trunk')
  })

  after(() => rmSync(repo.dir, { recursive: true, force: true }))

  it('throws when no default base exists', () => {
    assert.throws(() => resolveBase(repo.dir, undefined), /origin\/main, main/)
  })

  it('throws when an explicit base does not exist', () => {
    assert.throws(() => resolveBase(repo.dir, 'no-such-ref'), /no-such-ref/)
  })

  it('throws when the base shares no history with HEAD', () => {
    repo.git('switch', '--quiet', '--orphan', 'main')
    repo.write('b.ts', 'b\n')
    repo.git('add', 'b.ts')
    repo.git('commit', '--quiet', '-m', 'unrelated')
    repo.git('switch', '--quiet', 'trunk')

    assert.throws(() => resolveBase(repo.dir, undefined), /спільного предка/)
  })
})

describe('parseJsonc', () => {
  it('rejects an unterminated block comment instead of hanging Fast analysis', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { parseJsonc } from ${JSON.stringify(new URL('./repo.mjs', import.meta.url).href)}; parseJsonc('{ /* unfinished')`,
      ],
      { timeout: 1000, encoding: 'utf8' },
    )

    assert.equal(result.error, undefined, 'parser must terminate')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unterminated block comment/)
  })

  it('drops comments and trailing commas but keeps // inside strings', () => {
    const text = '{\n  // comment\n  "url": "https://x//y", /* block */ "list": [1, 2,],\n}'

    assert.deepEqual(parseJsonc(text), { url: 'https://x//y', list: [1, 2] })
  })
})
