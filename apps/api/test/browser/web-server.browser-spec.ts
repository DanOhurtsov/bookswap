import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWeb, processGroupAlive } from './web-server'

/**
 * 10j.2 review: `launchWeb` must not leak the dev server's process group when readiness fails — the
 * caller gets no handle then, so nobody else could stop it.
 *
 * A stand-in for `next dev`: a node "leader" that forks a long-lived "worker" into its own process
 * group (as Next does) and then either exits early or simply never becomes ready. No browser, no
 * Next, no network server — nothing listens on the readiness origin.
 */

const FAKE_SERVER = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.env.PIDS_FILE, JSON.stringify({ leader: process.pid, worker: worker.pid }))
if (process.env.MODE === 'exit-early') setTimeout(() => process.exit(3), 300)
else setInterval(() => {}, 1000)
`

// Port 1 on loopback: nothing listens there, so readiness can never succeed.
const NEVER_READY_ORIGIN = 'http://127.0.0.1:1'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookswap-web-server-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function launchFake(mode: 'exit-early' | 'never-ready', readyTimeoutMs: number) {
  return launchWeb({
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', MODE: mode, PIDS_FILE: join(dir, 'pids.json') },
    origin: NEVER_READY_ORIGIN,
    readyTimeoutMs,
  })
}

function spawnedPids(): { leader: number; worker: number } {
  return JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) as {
    leader: number
    worker: number
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

describe('launchWeb: a failed start leaves no process behind', () => {
  it('leader exits early while its worker keeps running → rejects and kills the worker too', async () => {
    await expect(launchFake('exit-early', 30_000)).rejects.toThrow(
      'web-сервер завершився з кодом 3',
    )

    const { leader, worker } = spawnedPids()

    expect(alive(worker)).toBe(false)
    expect(processGroupAlive(leader)).toBe(false)
  })

  it('readiness timeout with leader and worker alive → rejects and kills the whole group', async () => {
    await expect(launchFake('never-ready', 2_000)).rejects.toThrow(
      'web-сервер не став готовим за 2 с',
    )

    const { leader, worker } = spawnedPids()

    expect(alive(leader)).toBe(false)
    expect(alive(worker)).toBe(false)
    expect(processGroupAlive(leader)).toBe(false)
  })

  it('a command that cannot be spawned rejects instead of crashing the test process', async () => {
    await expect(
      launchWeb({
        command: join(dir, 'no-such-binary'),
        args: [],
        cwd: dir,
        env: {},
        origin: NEVER_READY_ORIGIN,
        readyTimeoutMs: 5_000,
      }),
    ).rejects.toThrow('web-сервер не запустився')
  })
})
