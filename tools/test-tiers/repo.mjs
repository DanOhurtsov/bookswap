import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { INTEGRATION } from './suites.mjs'

/** Removes `//` and `/* *\/` comments outside strings — turbo.json and the e2e Jest config use them. */
export function parseJsonc(text) {
  let out = ''
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (char === '"') {
      const start = i

      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      out += text.slice(start, ++i)
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)

      if (end === -1) throw new SyntaxError('unterminated block comment in JSONC')
      i = end + 2
    } else {
      out += char
      i++
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function refExists(root, ref) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

    return true
  } catch {
    return false
  }
}

/** Default base candidates: the PR target first, the local branch when there is no remote. */
export const DEFAULT_BASES = ['origin/main', 'main']

/**
 * The commit Fast compares against: the merge-base of HEAD with the base branch, so commits that
 * landed on main after the branch point are not mistaken for this branch's changes.
 *
 * @returns {{ ref: string, mergeBase: string }}
 * @throws when an explicit ref does not exist, or no default does, or there is no common ancestor
 */
export function resolveBase(root, explicitRef) {
  const candidates = explicitRef === undefined ? DEFAULT_BASES : [explicitRef]
  const ref = candidates.find((candidate) => refExists(root, candidate))

  if (ref === undefined) {
    throw new Error(`базову гілку не знайдено (перевірено: ${candidates.join(', ')})`)
  }

  try {
    return { ref, mergeBase: git(root, ['merge-base', ref, 'HEAD']).trim() }
  } catch {
    throw new Error(`немає спільного предка HEAD і ${ref} (shallow clone?)`)
  }
}

/**
 * Committed, staged, unstaged and untracked changes since `mergeBase`, as A/M/D. `--no-renames`
 * turns a rename into its deletion plus its addition, so both sides are classified.
 */
export function collectChanges(root, mergeBase) {
  const changes = []
  const tracked = git(root, ['diff', '--name-status', '--no-renames', '-z', mergeBase, '--'])
  const fields = tracked.split('\0').filter((field) => field !== '')

  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i][0]

    // T (type change) and U (unmerged) are edits as far as tests are concerned.
    changes.push({ status: status === 'A' || status === 'D' ? status : 'M', path: fields[i + 1] })
  }

  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (path !== '') changes.push({ status: 'A', path })
  }

  return changes
}

function workspaceDirs(root) {
  const manifest = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...manifest.matchAll(/^\s+-\s+'([^']+)\/\*'\s*$/gm)].map((match) => match[1])

  if (globs.length === 0)
    throw new Error('pnpm-workspace.yaml: не знайдено жодного шаблону пакетів')

  return globs.flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')),
      )
      .map((entry) => `${parent}/${entry.name}`),
  )
}

function jestRoots(root, dir) {
  const output = execFileSync(join(root, dir, 'node_modules/.bin/jest'), ['--showConfig'], {
    cwd: join(root, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return JSON.parse(output).configs[0].roots.map((path) => relative(root, path))
}

/** Workspace packages, their workspace dependencies, Jest roots and turbo.json cross-package inputs. */
export function readWorkspace(root) {
  const manifests = workspaceDirs(root).map((dir) => ({
    dir,
    json: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')),
  }))
  const names = new Set(manifests.map(({ json }) => json.name))

  const packages = manifests.map(({ dir, json }) => {
    const hasTests = typeof json.scripts?.test === 'string'
    const deps = Object.keys({ ...json.dependencies, ...json.devDependencies }).filter((name) =>
      names.has(name),
    )

    return {
      name: json.name,
      dir,
      deps,
      hasTests,
      hasGenerate: typeof json.scripts?.generate === 'string',
      roots: hasTests ? jestRoots(root, dir) : [],
    }
  })

  const crossInputs = {}
  const turbo = parseJsonc(readFileSync(join(root, 'turbo.json'), 'utf8'))

  for (const [task, definition] of Object.entries(turbo.tasks)) {
    const [pkg, name] = task.split('#')

    if (name !== 'test') continue
    for (const input of definition.inputs ?? []) {
      if (input.startsWith('$TURBO_ROOT$/')) {
        const path = input.slice('$TURBO_ROOT$/'.length)

        // Matched by exact path below; a glob would silently match nothing, so it fails the analysis.
        if (/[*?[{]/.test(path)) throw new Error(`turbo.json: ${task} — glob у вході ${input}`)
        crossInputs[path] = [...(crossInputs[path] ?? []), pkg]
      }
    }
  }

  return { packages, crossInputs, integration: INTEGRATION }
}
