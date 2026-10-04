import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'

/**
 * TD-01: proves that the rules added in eslint.config.mjs / apps/web/eslint.config.mjs
 * actually fire (not silently no-op through flat config's basePath — see the comment in the
 * root eslint.config.mjs — or through gaps like eslint-plugin-import's default
 * `import/extensions` excluding `.ts`).
 *
 * Lints through the real CLI binary, not the ESLint Node API: the API loads
 * eslint.config.mjs via a dynamic `import()`, and Jest in CJS mode throws "A dynamic import
 * callback was invoked without --experimental-vm-modules" on that call. A separate CLI process
 * has no such VM sandbox.
 *
 * Only real files on disk are linted, never `--stdin`: `import/no-cycle` builds its own cache
 * keyed by physical path and throws a TypeError when `--stdin-filename` points at a file that
 * doesn't exist. For rules that must be checked at a path inside a directory `pnpm lint`
 * actually scans (`components/ui`, `lib`, `features/**`), a transient file is written and
 * deleted within a single test — otherwise it either gets caught by that real scan (breaking
 * `pnpm lint`) or, sitting outside the scanned tree, never matches the rule's `files` pattern.
 */

const webCwd = path.resolve(__dirname, '..')
const repoRootCwd = path.resolve(webCwd, '..', '..')
// ESLint is a root workspace dependency, so a clean pnpm install is only guaranteed to create
// its shim under the root node_modules/.bin. Resolve the package itself from that root and run
// the JavaScript entry point with Node instead of depending on a package-local or OS-specific
// shell shim.
const eslintPackageJson = require.resolve('eslint/package.json', { paths: [repoRootCwd] })
const eslintCli = path.join(path.dirname(eslintPackageJson), 'bin/eslint.js')

const lintMessageSchema = z.object({
  ruleId: z.string().nullable(),
  severity: z.number(),
  message: z.string(),
})

const lintFileResultSchema = z.object({
  filePath: z.string(),
  messages: z.array(lintMessageSchema),
})

const lintResultSchema = z.array(lintFileResultSchema)

type LintResult = z.infer<typeof lintResultSchema>

/**
 * ESLint CLI exit codes: 0 = no lint errors, 1 = lint errors were found (the outcome most of
 * these tests assert on), 2 = fatal error — bad config, a crashed parser or resolver, no files
 * matched the pattern, and so on. A fatal run must fail loud here: silently returning an empty
 * result for it would make "the rule found nothing" indistinguishable from "the rule never ran".
 */
function runEslintCli(files: string[], options: { cwd: string }): LintResult {
  const result = spawnSync(process.execPath, [eslintCli, '--format', 'json', ...files], {
    cwd: options.cwd,
    encoding: 'utf-8',
  })

  if (result.error) {
    throw new Error(`failed to spawn the eslint CLI: ${result.error.message}`, {
      cause: result.error,
    })
  }
  if (result.signal) {
    throw new Error(`eslint CLI was killed by signal ${result.signal}\nstderr:\n${result.stderr}`)
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `eslint CLI exited with fatal status ${String(result.status)} (expected 0 or 1 — a completed ` +
        `lint pass, not a config/parser crash)\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    )
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(
      `eslint CLI wrote to stderr despite exiting ${String(result.status)}:\n${result.stderr}`,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`eslint CLI produced invalid JSON on stdout:\n${result.stdout}`, { cause })
  }

  const parsed = lintResultSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `eslint CLI JSON output did not match the expected shape: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

function ruleIds(result: LintResult): (string | null)[] {
  return result.flatMap((file) => file.messages.map((message) => message.ruleId))
}

/** A positive fixture is only convincing if it is fully clean, not merely free of one ruleId. */
function expectClean(result: LintResult): void {
  expect(result.flatMap((file) => file.messages)).toEqual([])
}

/** Writes a file, lints it, always deletes it afterwards — even if the assertion throws. */
function lintTransientFile(relativePath: string, code: string, cwd: string): LintResult {
  const absolutePath = path.join(cwd, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, code)
  try {
    return runEslintCli([relativePath], { cwd })
  } finally {
    fs.rmSync(absolutePath)
  }
}

describe('runEslintCli helper', () => {
  it('throws on a fatal ESLint exit (status 2) instead of returning an empty result', () => {
    expect(() =>
      runEslintCli(['eslint-fixtures/this-file-does-not-exist.ts'], { cwd: webCwd }),
    ).toThrow(/fatal status 2/)
  })

  it('does not throw on a normal lint run that reports errors (status 1)', () => {
    const result = runEslintCli(
      ['eslint-fixtures/cycle/module-a.ts', 'eslint-fixtures/cycle/module-b.ts'],
      { cwd: webCwd },
    )

    expect(ruleIds(result)).toContain('import/no-cycle')
  })
})

describe('import/no-cycle', () => {
  it('rejects a real cycle formed by relative imports between two sibling modules', () => {
    const result = runEslintCli(
      ['eslint-fixtures/cycle/module-a.ts', 'eslint-fixtures/cycle/module-b.ts'],
      { cwd: webCwd },
    )

    expect(ruleIds(result)).toContain('import/no-cycle')
  })
})

describe('import/no-cycle resolves the @/ alias independently of the invoking cwd', () => {
  it('detects an alias-formed cycle when invoked with cwd = apps/web, the real per-package `pnpm lint` invocation', () => {
    const result = runEslintCli(
      ['eslint-fixtures/cycle-alias/module-a.ts', 'eslint-fixtures/cycle-alias/module-b.ts'],
      { cwd: webCwd },
    )

    expect(ruleIds(result)).toContain('import/no-cycle')
  })

  it('detects the same alias-formed cycle when invoked with cwd = repo root', () => {
    // A relative eslint-import-resolver-typescript `project` entry resolves against
    // `process.cwd()`, so this cwd is exactly the case that was broken before project paths
    // were made absolute: from the repo root, a root-relative `apps/web/tsconfig.json` would
    // have worked by coincidence, but from apps/web itself (the case above) it would have
    // resolved to the nonexistent `apps/web/apps/web/tsconfig.json`.
    const result = runEslintCli(
      [
        'apps/web/eslint-fixtures/cycle-alias/module-a.ts',
        'apps/web/eslint-fixtures/cycle-alias/module-b.ts',
      ],
      { cwd: repoRootCwd },
    )

    expect(ruleIds(result)).toContain('import/no-cycle')
  })
})

describe('no-restricted-imports: feature public-interface boundary (CONVENTIONS.md §1.3)', () => {
  it('allows a feature to reach its own internals through the @/ alias', () => {
    const code = [
      "import { createSearchStep } from '@/features/catalog/add-book/model/add-book-step'",
      'export const usage = createSearchStep',
      '',
    ].join('\n')

    const result = lintTransientFile(
      'features/catalog/add-book/__td01-own-feature-fixture__.ts',
      code,
      webCwd,
    )

    expectClean(result)
  })

  it('rejects a deep import into this feature from a different feature', () => {
    const code = [
      "import { AddBookScreen } from '@/features/catalog/add-book/components/AddBookScreen'",
      'export const usage = AddBookScreen',
      '',
    ].join('\n')

    const result = lintTransientFile(
      'features/other-feature/__td01-cross-feature-fixture__.ts',
      code,
      webCwd,
    )

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })

  it('allows any consumer to import through the public client barrel', () => {
    const code = [
      "import { AddBookScreen } from '@/features/catalog/add-book/index.client'",
      'export const usage = AddBookScreen',
      '',
    ].join('\n')

    const result = lintTransientFile(
      'features/other-feature/__td01-barrel-fixture__.ts',
      code,
      webCwd,
    )

    expectClean(result)
  })
})

describe('no-restricted-imports: components/ui and lib must not depend on features (CONVENTIONS.md §1.3)', () => {
  const code = [
    "import { AddBookScreen } from '@/features/catalog/add-book/index.client'",
    'export const usage = AddBookScreen',
    '',
  ].join('\n')

  it('rejects a feature import from components/ui, even through the public barrel', () => {
    const result = lintTransientFile('components/ui/__td01-boundary-fixture__.ts', code, webCwd)

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })

  it('does not restrict an ordinary, non design-system component with the same rule', () => {
    const result = lintTransientFile(
      'components/Friends/__td01-boundary-fixture__.ts',
      code,
      webCwd,
    )

    expectClean(result)
  })
})

describe('no-restricted-imports composition across multiple features (regression: last-config-wins)', () => {
  // Fixtures under eslint-fixtures/feature-composition/ carry their own eslint.config.mjs,
  // which calls buildFeatureBoundaryConfig — the same generator apps/web/eslint.config.mjs
  // uses for the real KNOWN_FEATURES list — with two synthetic feature names. With only one
  // real feature, a bug where a later config block silently discards an earlier one's
  // no-restricted-imports options cannot show up in a test; it takes at least two.
  const compositionCwd = path.join(webCwd, 'eslint-fixtures/feature-composition')

  it('restricts an external consumer from feature A internals', () => {
    const result = runEslintCli(['consumers/external-imports-feature-a-internal.ts'], {
      cwd: compositionCwd,
    })

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })

  it('restricts an external consumer from feature B internals', () => {
    const result = runEslintCli(['consumers/external-imports-feature-b-internal.ts'], {
      cwd: compositionCwd,
    })

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })

  it('allows an external consumer to import feature A through its public barrel', () => {
    const result = runEslintCli(['consumers/external-imports-feature-a-barrel.ts'], {
      cwd: compositionCwd,
    })

    expectClean(result)
  })

  it('allows an external consumer to import feature B through its public barrel', () => {
    const result = runEslintCli(['consumers/external-imports-feature-b-barrel.ts'], {
      cwd: compositionCwd,
    })

    expectClean(result)
  })

  it('allows feature A to import its own internals', () => {
    const result = runEslintCli(['features/fixture-feature-a/components/own-internal-import.ts'], {
      cwd: compositionCwd,
    })

    expectClean(result)
  })

  it('allows feature B to import its own internals', () => {
    const result = runEslintCli(['features/fixture-feature-b/components/own-internal-import.ts'], {
      cwd: compositionCwd,
    })

    expectClean(result)
  })

  it('rejects feature A importing feature B internals directly', () => {
    const result = runEslintCli(['features/fixture-feature-a/components/cross-feature-import.ts'], {
      cwd: compositionCwd,
    })

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })

  it('rejects feature B importing feature A internals directly', () => {
    const result = runEslintCli(['features/fixture-feature-b/components/cross-feature-import.ts'], {
      cwd: compositionCwd,
    })

    expect(ruleIds(result)).toContain('no-restricted-imports')
  })
})
