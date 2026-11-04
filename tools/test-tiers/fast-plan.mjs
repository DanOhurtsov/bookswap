/**
 * Fast tier: which unit tests the changes can reach. Pure — the caller collects the changes from git
 * and the workspace from disk, so every rule below is unit-tested without a repository.
 *
 * Granularity is the package, refined by Jest's own import graph (`--findRelatedTests`) only where
 * that graph can actually see the dependency. Everywhere it cannot, the rule widens instead of
 * guessing: the whole package suite, or the whole Standard tier.
 */

const CODE_FILE = /\.[cm]?[jt]sx?$|\.json$/
// Unit and integration specs alike: changing one never changes what the package builds.
const TEST_FILE = /[.-]spec\.tsx?$|\.test\.mjs$/

// A test that reads sources or runs a tool through the filesystem (a route list from readdirSync,
// ESLint over fixtures) depends on files Jest's import graph never sees, so it joins every Fast run
// of its package.
const FILESYSTEM_ACCESS =
  /(?:from|import\(|require\()\s*['"](?:(?:node:)?(?:fs|fs\/promises|child_process)|eslint)['"]/

export function readsFilesystem(testSource) {
  return FILESYSTEM_ACCESS.test(testSource)
}

/** No test can depend on prose. Everything else outside a package widens to Standard. */
function isIgnored(path) {
  return path.startsWith('docs/') || path.endsWith('.md')
}

function closure(start, edges) {
  const seen = new Set()
  const stack = [...start]

  while (stack.length > 0) {
    const name = stack.pop()

    if (seen.has(name)) continue
    seen.add(name)
    stack.push(...(edges.get(name) ?? []))
  }

  return seen
}

/**
 * @param {{ status: 'A' | 'M' | 'D', path: string }[]} changes  repo-relative; a rename arrives as
 *   a deletion plus an addition
 * @param {{
 *   packages: { name: string, dir: string, deps: string[], roots: string[], hasTests: boolean }[],
 *   crossInputs: Record<string, string[]>,
 *   integration: { id: string, packages: string[] }[],
 * }} workspace  `roots` — Jest roots, repo-relative; `crossInputs` — files outside a package that
 *   turbo.json declares as inputs of that package's `test` task; `integration` — the suites Fast
 *   never runs, with the packages whose code they execute
 */
export function planFast(changes, workspace) {
  const byName = new Map(workspace.packages.map((pkg) => [pkg.name, pkg]))
  const dependents = new Map()

  for (const pkg of workspace.packages) {
    for (const dep of pkg.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), pkg.name])
  }

  const selection = new Map()
  const select = (name) => {
    if (!selection.has(name)) selection.set(name, { full: false, files: new Set(), reasons: [] })

    return selection.get(name)
  }
  const widen = (name, reason) => {
    const entry = select(name)

    entry.full = true
    entry.reasons.push(reason)
  }

  const ignored = []
  const touched = new Set()
  const buildChanged = new Set()

  for (const { status, path } of changes) {
    if (isIgnored(path)) {
      ignored.push(path)
      continue
    }

    for (const consumer of workspace.crossInputs[path] ?? []) {
      widen(consumer, `${path} — вхід test-задачі ${consumer} у turbo.json`)
    }

    const pkg = workspace.packages.find((candidate) => path.startsWith(`${candidate.dir}/`))

    if (pkg === undefined) {
      return { mode: 'standard', reason: `змінено файл поза пакетами: ${path}`, ignored }
    }

    const relative = path.slice(pkg.dir.length + 1)
    const isTest = TEST_FILE.test(relative)

    touched.add(pkg.name)
    if (!isTest) buildChanged.add(pkg.name)

    if (status === 'D') {
      // A deleted test needs nothing run. A deleted module is gone from Jest's haste map, so its
      // importers cannot be found through it.
      if (!isTest) widen(pkg.name, `видалено ${path}: Jest не знайде модулі, що його імпортували`)
    } else if (!relative.includes('/')) {
      widen(pkg.name, `змінено конфігурацію пакета: ${path}`)
    } else if (!CODE_FILE.test(relative)) {
      widen(pkg.name, `${path} — не модуль, граф імпортів Jest його не бачить`)
    } else if (!pkg.roots.some((root) => path.startsWith(`${root}/`))) {
      widen(pkg.name, `${path} поза roots Jest пакета ${pkg.name}`)
    } else {
      select(pkg.name).files.add(path)
    }
  }

  // Consumers import a dependency's build output, not its sources, so Jest's graph in the consumer
  // never reaches the changed file: every transitive consumer runs its whole suite — also one with
  // changes of its own, whose related selection would miss what the dependency change reaches.
  for (const changed of buildChanged) {
    for (const name of closure(dependents.get(changed) ?? [], dependents)) {
      widen(name, `залежить від ${changed}, де змінено код`)
    }
  }

  const deps = new Map(workspace.packages.map((pkg) => [pkg.name, pkg.deps]))
  const integration = workspace.integration
    .filter((suite) => [...closure(suite.packages, deps)].some((name) => touched.has(name)))
    .map((suite) => suite.id)

  const packages = [...selection]
    .filter(([name]) => byName.get(name)?.hasTests === true)
    .map(([name, entry]) => ({
      name,
      dir: byName.get(name).dir,
      full: entry.full,
      files: entry.full ? [] : [...entry.files].sort(),
      reasons: entry.reasons,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { mode: 'fast', packages, ignored, integration }
}
