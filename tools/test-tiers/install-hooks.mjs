#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install only this checkout's versioned hooks; never replace another hooks configuration. */
export function installHooks(root = ROOT) {
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
  })

  if (current.status !== 0 && current.status !== 1)
    throw new Error('Не вдалося прочитати Git config')
  const configured = current.stdout.trim()

  if (configured !== '' && resolve(root, configured) !== resolve(root, '.githooks')) {
    throw new Error(`Уже налаштовано core.hooksPath=${configured}; автоматичну заміну заборонено.`)
  }

  const hook = resolve(root, '.githooks/pre-commit')
  const existingHook = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  if (configured === '' && existsSync(resolve(root, existingHook))) {
    throw new Error('Уже існує локальний pre-commit; узгодьте його перенесення до .githooks.')
  }
  if (!existsSync(hook)) throw new Error('Відсутній .githooks/pre-commit')

  chmodSync(hook, 0o755)
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    installHooks()
    process.stdout.write('Pre-commit встановлено: кожен коміт запускає Standard без кешу Turbo.\n')
  } catch (error) {
    process.stderr.write(`hooks: ${error.message}\n`)
    process.exitCode = 1
  }
}
