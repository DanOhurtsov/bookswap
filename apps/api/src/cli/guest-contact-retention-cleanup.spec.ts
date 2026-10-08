import {
  closeWithBudget,
  describeFailure,
  executeCleanupRun,
  type CliIO,
  type CloseableApp,
  type ExecuteDeps,
} from './guest-contact-retention-cleanup'
import type { RetentionCleanupSummary } from '../external-borrowers/guest-contact-retention-cleanup.service'

/**
 * This spec drives `executeCleanupRun` with injected stages and never starts Nest. The real CLI
 * module evaluates `ConfigModule.forRoot({ validate })` on import, which reads the developer's own
 * root `.env`: a half-filled Telegram block there would fail this unit spec at import time. The
 * module is replaced so the result does not depend on any local variable; the real wiring (and the
 * validation it runs) is covered by `guest-contact-retention-cleanup-cli.db-spec.ts` against the
 * built command.
 */
jest.mock('./guest-contact-retention-cli.module', () => ({
  GuestContactRetentionCliModule: class GuestContactRetentionCliModuleStub {},
}))

/**
 * Stage 10 (10h): shutdown policy затверджена PO — `app.close()` під бюджетом 5000 мс; таймаут
 * чи відхилення закриття завжди дає `exit 1` через примусове завершення, ніколи `exit 0`; успіх
 * друкується лише ПІСЛЯ підтвердженого закриття; жоден шлях (контекст/`run()`/закриття) не
 * друкує сирий `.message`/`.stack`/SQL/`DATABASE_URL`/alias.
 *
 * Юніт-рівень, без реального Nest/БД/затримок у реальному часі (окрім одного малого справжнього
 * таймауту для перевірки самого механізму) — `executeCleanupRun` інʼєктує кожен з трьох етапів,
 * тож кожен шлях збою детермінований і швидкий. `guest-contact-retention-cleanup-cli.db-spec.ts`
 * окремо доводить те саме на зібраній команді проти реальної (недосяжної) БД.
 */
describe('describeFailure — безпечний сигнал збою, без message/stack', () => {
  const SENTINEL = 'SECRET_ALIAS_OR_SQL_VALUE_THAT_MUST_NEVER_LEAK'

  it('Error із валідним Prisma-кодом (Pxxxx) — клас + код', () => {
    const error = Object.assign(new Error(`INSERT INTO … ${SENTINEL}`), { code: 'P2028' })

    const result = describeFailure(error)

    expect(result).toBe('Error (код P2028)')
    expect(result).not.toContain(SENTINEL)
  })

  it('Error із кодом, що НЕ відповідає безпечному формату — код відкидається, лише клас', () => {
    const error = Object.assign(new Error(SENTINEL), { code: SENTINEL })

    const result = describeFailure(error)

    expect(result).toBe('Error')
    expect(result).not.toContain(SENTINEL)
  })

  it('Error без коду — лише клас, повідомлення не потрапляє у вивід', () => {
    const error = new TypeError(SENTINEL)

    const result = describeFailure(error)

    expect(result).toBe('TypeError')
    expect(result).not.toContain(SENTINEL)
  })

  it('не-Error значення — загальний безпечний рядок', () => {
    expect(describeFailure(SENTINEL)).toBe('невідома помилка (не Error)')
    expect(describeFailure(null)).toBe('невідома помилка (не Error)')
    expect(describeFailure(undefined)).toBe('невідома помилка (не Error)')
  })
})

describe('closeWithBudget', () => {
  it('close() встигає — { ok: true }', async () => {
    const app: CloseableApp = { close: () => Promise.resolve() }

    await expect(closeWithBudget(app, 1000)).resolves.toEqual({ ok: true })
  })

  it('close() відхиляється — { ok: false, reason: "error" }, помилка передається як є (не форматується тут)', async () => {
    const closeError = new Error('SECRET_SQL_TEXT_THAT_MUST_NOT_LEAK')
    const app: CloseableApp = { close: () => Promise.reject(closeError) }

    const result = await closeWithBudget(app, 1000)

    expect(result).toEqual({ ok: false, reason: 'error', error: closeError })
  })

  it('close() не встигає за бюджет — { ok: false, reason: "timeout" }', async () => {
    const app: CloseableApp = { close: () => new Promise(() => undefined) } // ніколи не вирішується

    const result = await closeWithBudget(app, 20)

    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('executeCleanupRun — контрольована обробка на всіх трьох етапах', () => {
  function io(): CliIO & { outLines: string[]; failLines: string[]; forceExitCalls: number[] } {
    const outLines: string[] = []
    const failLines: string[] = []
    const forceExitCalls: number[] = []

    return {
      outLines,
      failLines,
      forceExitCalls,
      out: (line) => outLines.push(line),
      fail: (line) => failLines.push(line),
      forceExit: (code) => forceExitCalls.push(code),
    }
  }

  const SENTINEL = 'SECRET_ALIAS_OR_SQL_VALUE_THAT_MUST_NEVER_LEAK'
  const summary: RetentionCleanupSummary = { backfilled: 2, deleted: 3 }

  function deps(overrides: Partial<ExecuteDeps<CloseableApp>> = {}): ExecuteDeps<CloseableApp> {
    return {
      createContext: () => Promise.resolve({ close: () => Promise.resolve() }),
      runCleanup: () => Promise.resolve(summary),
      closeBudgetMs: 1000,
      ...overrides,
    }
  }

  it('щасливий шлях: контекст → run → close усі успішні — exit 0, друк лише ПІСЛЯ закриття', async () => {
    const testIo = io()
    const exitCode = await executeCleanupRun(testIo, deps())

    expect(exitCode).toBe(0)
    expect(testIo.outLines).toEqual([
      'Перераховано retainUntil: 2',
      'Видалено гостьових контактів: 3',
    ])
    expect(testIo.failLines).toEqual([])
    expect(testIo.forceExitCalls).toEqual([])
  })

  it('createContext відхиляється — exit 1, безпечне повідомлення, run/close ніколи не викликаються, forceExit не викликається', async () => {
    const testIo = io()
    const runCleanup = jest.fn<Promise<RetentionCleanupSummary>, [CloseableApp]>()

    const exitCode = await executeCleanupRun(
      testIo,
      deps({
        createContext: () => Promise.reject(new Error(`connect ECONNREFUSED ${SENTINEL}`)),
        runCleanup,
      }),
    )

    expect(exitCode).toBe(1)
    expect(runCleanup).not.toHaveBeenCalled()
    expect(testIo.forceExitCalls).toEqual([])
    expect(testIo.outLines).toEqual([])
    expect(testIo.failLines.join('\n')).not.toContain(SENTINEL)
    expect(testIo.failLines.some((line) => line.includes('контекст'))).toBe(true)
  })

  it('run() відхиляється, close() успішний — exit 1, без success-виводу, forceExit не викликається (успішне закриття не примушує вихід)', async () => {
    const testIo = io()

    const exitCode = await executeCleanupRun(
      testIo,
      deps({
        runCleanup: () => Promise.reject(new Error(`DELETE … ${SENTINEL}`)),
      }),
    )

    expect(exitCode).toBe(1)
    expect(testIo.outLines).toEqual([])
    expect(testIo.forceExitCalls).toEqual([])
    expect(testIo.failLines.join('\n')).not.toContain(SENTINEL)
  })

  it('run() успішний, close() ВІДХИЛЯЄТЬСЯ — forceExit(1), а НЕ тихий exit 0: успіх run() не скасовує збій закриття', async () => {
    const testIo = io()

    const exitCode = await executeCleanupRun(
      testIo,
      deps({
        closeBudgetMs: 1000,
        createContext: () =>
          Promise.resolve({ close: () => Promise.reject(new Error(`SQL ${SENTINEL}`)) }),
      }),
    )

    expect(testIo.forceExitCalls).toEqual([1])
    expect(exitCode).toBe(1)
    // Успіх НЕ друкується — закриття не підтверджене.
    expect(testIo.outLines).toEqual([])
    expect(testIo.failLines.join('\n')).not.toContain(SENTINEL)
    expect(testIo.failLines.some((line) => line.includes('Закриття ресурсів'))).toBe(true)
  })

  it('run() успішний, close() НЕ встигає за бюджет — forceExit(1), повідомлення про таймаут, без success-виводу', async () => {
    const testIo = io()

    const exitCode = await executeCleanupRun(
      testIo,
      deps({
        closeBudgetMs: 20,
        createContext: () => Promise.resolve({ close: () => new Promise(() => undefined) }),
      }),
    )

    expect(testIo.forceExitCalls).toEqual([1])
    expect(exitCode).toBe(1)
    expect(testIo.outLines).toEqual([])
    expect(testIo.failLines.some((line) => line.includes('20') && line.includes('примусове'))).toBe(
      true,
    )
  })

  it('і run(), і close() відхиляються — все одно forceExit(1), НЕ exit 0', async () => {
    const testIo = io()

    const exitCode = await executeCleanupRun(
      testIo,
      deps({
        runCleanup: () => Promise.reject(new Error('run failed')),
        createContext: () =>
          Promise.resolve({ close: () => Promise.reject(new Error('close failed too')) }),
      }),
    )

    expect(testIo.forceExitCalls).toEqual([1])
    expect(exitCode).toBe(1)
    expect(testIo.outLines).toEqual([])
  })
})
