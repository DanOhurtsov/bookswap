import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * `next dev` for a browser spec, pointed at the API this spec's process is serving. Shared by every
 * `*.browser-spec.ts`: they run one after another in the same working copy, so `stopWeb` waits for
 * the dev server's whole process group to be gone before the next file starts its own.
 *
 * The group is the unit, not the `next` process: `next dev` forks workers into it, and the leader
 * can exit (a crash, a lock conflict) while they keep running. Hence `detached: true` for spawning
 * and `kill(-pgid)` for both signalling and the liveness check.
 */

const STOP_GRACE_MS = 10_000
const STOP_KILL_WAIT_MS = 5_000

export interface WebProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Readiness is `GET ${origin}/login` answering 2xx. */
  origin: string
  readyTimeoutMs: number
}

async function waitForWeb(
  child: ChildProcess,
  { origin, readyTimeoutMs }: Pick<WebProcessOptions, 'origin' | 'readyTimeoutMs'>,
  spawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs

  while (Date.now() < deadline) {
    const failed = spawnError()

    if (failed !== undefined) throw new Error(`web-сервер не запустився: ${failed.message}`)
    if (child.exitCode !== null)
      throw new Error(`web-сервер завершився з кодом ${String(child.exitCode)}`)
    if (child.signalCode !== null)
      throw new Error(`web-сервер завершився сигналом ${child.signalCode}`)

    try {
      const response = await fetch(`${origin}/login`)

      if (response.ok) return
    } catch {
      // сервер ще піднімається
    }

    await new Promise((r) => setTimeout(r, Math.min(1000, readyTimeoutMs)))
  }

  throw new Error(`web-сервер не став готовим за ${String(readyTimeoutMs / 1000)} с`)
}

/**
 * Spawns the server in its own process group and waits for readiness. If readiness fails — early
 * exit, spawn error or timeout — the whole group is stopped HERE before the error propagates: the
 * caller never received the handle, so its `afterAll` could not do it.
 */
export async function launchWeb(options: WebProcessOptions): Promise<ChildProcess> {
  const web = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let spawnError: Error | undefined

  // Without a listener a spawn failure (ENOENT) is an uncaught 'error' event.
  web.once('error', (error) => {
    spawnError = error
  })
  web.stdout?.resume()
  web.stderr?.resume()

  try {
    await waitForWeb(web, options, () => spawnError)
  } catch (error) {
    await stopWeb(web)
    throw error
  }

  return web
}

export function startWeb(
  app: INestApplication<App>,
  webPort: number,
  webOrigin: string,
): Promise<ChildProcess> {
  const apiPort = ((app.getHttpServer() as Server).address() as AddressInfo).port
  const webDir = resolve(__dirname, '../../../web')

  return launchWeb({
    command: resolve(webDir, 'node_modules/.bin/next'),
    args: ['dev', '--port', String(webPort)],
    cwd: webDir,
    // Мінімальне оточення: web не має бачити ні DATABASE_URL, ні решти конфігурації API.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_API_URL: `http://localhost:${String(apiPort)}`,
    },
    origin: webOrigin,
    readyTimeoutMs: 120_000,
  })
}

/** Whether any process of the group `pgid` still exists (signal 0 only checks). */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)

    return true
  } catch {
    return false
  }
}

function signalGroup(pgid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pgid, name)
  } catch {
    // група вже порожня
  }
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (processGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false

    await new Promise((r) => setTimeout(r, 100))
  }

  return true
}

/**
 * SIGTERM to the whole group, SIGKILL after a grace period, and resolves only once no process of
 * the group is left. Also when the leader itself has already exited: its workers may not have.
 */
export async function stopWeb(web: ChildProcess | undefined): Promise<void> {
  const pgid = web?.pid

  if (pgid === undefined) return

  signalGroup(pgid, 'SIGTERM')

  if (await waitForGroupExit(pgid, STOP_GRACE_MS)) return

  signalGroup(pgid, 'SIGKILL')

  if (!(await waitForGroupExit(pgid, STOP_KILL_WAIT_MS)))
    throw new Error(`Група процесів web-сервера ${String(pgid)} не завершилася після SIGKILL`)
}
