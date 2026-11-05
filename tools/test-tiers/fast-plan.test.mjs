import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planFast, readsFilesystem } from './fast-plan.mjs'

const SHARED = '@bookswap/shared'
const WEB = '@bookswap/web'
const API = '@bookswap/api'

const workspace = {
  packages: [
    {
      name: SHARED,
      dir: 'packages/shared',
      deps: [],
      roots: ['packages/shared/src'],
      hasTests: true,
    },
    { name: WEB, dir: 'apps/web', deps: [SHARED], roots: ['apps/web'], hasTests: true },
    { name: API, dir: 'apps/api', deps: [SHARED], roots: ['apps/api'], hasTests: true },
  ],
  crossInputs: { 'apps/web/public/library-import-template.csv': [API] },
  integration: [
    { id: 'e2e', packages: [API] },
    { id: 'db', packages: [API] },
    { id: 'browser', packages: [API, WEB] },
  ],
}

const modified = (...paths) => paths.map((path) => ({ status: 'M', path }))
const byName = (plan) => Object.fromEntries(plan.packages.map((pkg) => [pkg.name, pkg]))

describe('planFast', () => {
  it('a web module change selects only web, by Jest relation', () => {
    const plan = planFast(modified('apps/web/features/loans/model/loan-history.ts'), workspace)

    assert.equal(plan.mode, 'fast')
    assert.deepEqual(plan.packages, [
      {
        name: WEB,
        dir: 'apps/web',
        full: false,
        files: ['apps/web/features/loans/model/loan-history.ts'],
        reasons: [],
      },
    ])
    assert.deepEqual(plan.integration, ['browser'])
  })

  it('a shared source change runs web and api in full: they import its build, not its sources', () => {
    const plan = byName(planFast(modified('packages/shared/src/loans.ts'), workspace))

    assert.deepEqual(plan[SHARED].files, ['packages/shared/src/loans.ts'])
    assert.equal(plan[SHARED].full, false)
    assert.equal(plan[WEB].full, true)
    assert.equal(plan[API].full, true)
    assert.match(plan[WEB].reasons[0], /@bookswap\/shared/)
  })

  it('a consumer with changes of its own still runs in full when a dependency changed', () => {
    const plan = byName(
      planFast(
        modified('apps/api/src/loans/loan.transitions.ts', 'packages/shared/src/loans.ts'),
        workspace,
      ),
    )

    assert.equal(plan[API].full, true)
    assert.deepEqual(plan[API].files, [])
    assert.match(plan[API].reasons[0], /@bookswap\/shared/)
  })

  it('a shared test-only change does not reach the consumers', () => {
    const plan = planFast(modified('packages/shared/src/loans.spec.ts'), workspace)

    assert.deepEqual(
      plan.packages.map((pkg) => pkg.name),
      [SHARED],
    )
  })

  it('a changed or new test is passed to Jest as a related file', () => {
    const plan = planFast(
      [
        { status: 'M', path: 'apps/api/src/loans/loan.transitions.spec.ts' },
        { status: 'A', path: 'apps/api/src/loans/new-rule.spec.ts' },
      ],
      workspace,
    )

    assert.deepEqual(plan.packages[0].files, [
      'apps/api/src/loans/loan.transitions.spec.ts',
      'apps/api/src/loans/new-rule.spec.ts',
    ])
  })

  it('a deleted module widens its package; a deleted test needs nothing run', () => {
    const deletedModule = byName(
      planFast([{ status: 'D', path: 'apps/api/src/loans/old.ts' }], workspace),
    )
    const deletedTest = planFast(
      [{ status: 'D', path: 'apps/api/src/loans/old.spec.ts' }],
      workspace,
    )

    assert.equal(deletedModule[API].full, true)
    assert.deepEqual(deletedTest.packages, [])
  })

  it('a rename (deletion + addition) widens like a deletion', () => {
    const plan = byName(
      planFast(
        [
          { status: 'D', path: 'apps/web/lib/old-name.ts' },
          { status: 'A', path: 'apps/web/lib/new-name.ts' },
        ],
        workspace,
      ),
    )

    assert.equal(plan[WEB].full, true)
  })

  it('package-level configuration widens that package', () => {
    for (const path of [
      'apps/web/jest.config.js',
      'apps/web/tsconfig.spec.json',
      'apps/api/package.json',
    ]) {
      const pkg = planFast(modified(path), workspace).packages[0]

      assert.equal(pkg.full, true, path)
      assert.match(pkg.reasons[0], /конфігурацію/)
    }
  })

  it('a non-module file widens its package — Jest cannot see who reads it', () => {
    const plan = byName(
      planFast(modified('apps/api/prisma/schema.prisma', 'apps/web/app/globals.css'), workspace),
    )

    assert.equal(plan[API].full, true)
    assert.equal(plan[WEB].full, true)
  })

  it('a code file outside the Jest roots widens its package', () => {
    const plan = byName(planFast(modified('packages/shared/scripts/x.ts'), workspace))

    assert.equal(plan[SHARED].full, true)
  })

  it('a turbo.json cross-package test input widens the consuming package', () => {
    const plan = byName(
      planFast(modified('apps/web/public/library-import-template.csv'), workspace),
    )

    assert.equal(plan[API].full, true)
  })

  it('a change outside every package widens to Standard', () => {
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'turbo.json',
      'tsconfig.base.json',
      'tools/test-tiers/run.mjs',
    ]) {
      const plan = planFast(modified('apps/web/lib/a.ts', path), workspace)

      assert.equal(plan.mode, 'standard', path)
      assert.match(plan.reason, new RegExp(path.replace('.', '\\.')))
    }
  })

  it('documentation changes run nothing', () => {
    const plan = planFast(modified('docs/plan/roadmap-v2.md', 'apps/web/AGENTS.md'), workspace)

    assert.deepEqual(plan.packages, [])
    assert.deepEqual(plan.ignored, ['docs/plan/roadmap-v2.md', 'apps/web/AGENTS.md'])
    assert.deepEqual(plan.integration, [])
  })

  it('reports every integration suite an api or shared change can reach', () => {
    assert.deepEqual(planFast(modified('apps/api/src/a.ts'), workspace).integration, [
      'e2e',
      'db',
      'browser',
    ])
    assert.deepEqual(planFast(modified('packages/shared/src/a.ts'), workspace).integration, [
      'e2e',
      'db',
      'browser',
    ])
  })
})

describe('readsFilesystem', () => {
  it('recognises tests that read files or run tools outside the import graph', () => {
    for (const source of [
      "import { readFileSync } from 'node:fs'",
      "import { readdir } from 'fs/promises'",
      "const fs = require('fs')",
      "const { execFileSync } = await import('node:child_process')",
      "import { ESLint } from 'eslint'",
    ]) {
      assert.equal(readsFilesystem(source), true, source)
    }
  })

  it('ignores ordinary imports', () => {
    assert.equal(
      readsFilesystem("import { render } from '@testing-library/react'\nconst fsm = 1"),
      false,
    )
  })
})
