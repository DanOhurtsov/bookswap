import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { createGraph } from './fixtures'
import { createTestPrismaClient, testDatabaseUrl, truncateAll } from './test-database'

const execFileAsync = promisify(execFile)

/**
 * Stage 10 (10h, docs/plan/stage-10-real-world-history.md §0.9, RET6/RET9): фактичний запуск
 * ЗІБРАНОЇ CLI-команди (`pnpm --filter @bookswap/api run build` → `dist/cli/guest-contact-
 * retention-cleanup.js`) окремим Node-процесом проти справжньої (ізольованої тестової) БД — не
 * виклик сервісу напряму (те вже роблять `retention.spec.ts`/`guest-contact-retention.e2e-spec.ts`).
 * Доводить те, чого юніт- і e2e-рівень не бачать: реальний `NestFactory.createApplicationContext`,
 * реальне читання `.env`/`DATABASE_URL`, реальний `process.exitCode`, реальний stdout/stderr.
 *
 * Потребує попереднього `pnpm --filter @bookswap/api run build` (`gate.sh` це вже гарантує:
 * `pnpm turbo run test build --force` іде ПЕРЕД `pnpm db:up && … && pnpm test:db`).
 */
const CLI_PATH = resolve(__dirname, '../../dist/cli/guest-contact-retention-cleanup.js')

describe('CLI guest-contact-retention-cleanup — зібрана команда проти реальної БД', () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createTestPrismaClient()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function guestContactWithReturnedLoan(daysAgo: number): Promise<{
    contactId: string
    loanId: string
  }> {
    const graph = await createGraph(prisma)
    const contact = await prisma.externalBorrower.create({
      data: {
        ownerId: graph.ownerId,
        alias: 'CLI E2E Синтетичний Аліас',
        ownerInformedAt: new Date(),
      },
    })
    const returnedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    const loan = await prisma.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: null,
        borrowerKind: 'GUEST',
        origin: 'RECORDED_GUEST',
        borrowerContactId: contact.id,
        status: 'RETURNED',
        requestedAt: null,
        handedAt: new Date(returnedAt.getTime() - 10 * 24 * 60 * 60 * 1000),
        returnedAt,
      },
    })

    await prisma.loanEvent.create({
      data: { loanId: loan.id, type: 'GUEST_LOAN_RECORDED', actorId: graph.ownerId },
    })
    await prisma.loanEvent.create({
      data: {
        loanId: loan.id,
        type: 'LOAN_RETURNED',
        actorId: graph.ownerId,
        occurredAt: returnedAt,
      },
    })

    // Легасі-контакт 10f.2/10f.3/10g: retainUntil ще ніколи не рахувався.
    await prisma.externalBorrower.update({ where: { id: contact.id }, data: { retainUntil: null } })

    return { contactId: contact.id, loanId: loan.id }
  }

  it('exit 0; видаляє прострочений контакт (backfill із NULL + цей самий прохід), зберігає Loan/LoanEvent, не друкує alias', async () => {
    const { contactId, loanId } = await guestContactWithReturnedLoan(91) // > 90д тому

    const { stdout, stderr } = await execFileAsync('node', [CLI_PATH], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        DIRECT_DATABASE_URL: testDatabaseUrl(),
      },
    })

    expect(stdout).not.toContain('CLI E2E Синтетичний Аліас')
    expect(stderr).not.toContain('CLI E2E Синтетичний Аліас')
    expect(stdout).toMatch(/Перераховано retainUntil: \d+/)
    expect(stdout).toMatch(/Видалено гостьових контактів: \d+/)

    expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

    expect(loan.borrowerContactId).toBeNull()
    expect(loan.borrowerKind).toBe('GUEST')
    expect(loan.status).toBe('RETURNED')
    expect(await prisma.loanEvent.count({ where: { loanId } })).toBe(2)
  })

  it('exit 0; контакт у межах 90 днів — лишається (лише перерахунок, без видалення)', async () => {
    const { contactId } = await guestContactWithReturnedLoan(10) // повернуто 10 днів тому

    await execFileAsync('node', [CLI_PATH], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        DIRECT_DATABASE_URL: testDatabaseUrl(),
      },
    })

    const row = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

    expect(row.retainUntil).not.toBeNull()
    expect(row.retainUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('RET6: два одночасні запуски зібраної CLI — жодного процесу не падає, контакт стирається рівно один раз', async () => {
    const { contactId } = await guestContactWithReturnedLoan(91)
    const env = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      DIRECT_DATABASE_URL: testDatabaseUrl(),
    }

    const [first, second] = await Promise.all([
      execFileAsync('node', [CLI_PATH], { env }),
      execFileAsync('node', [CLI_PATH], { env }),
    ])

    expect(first.stdout).toMatch(/Видалено гостьових контактів: \d+/)
    expect(second.stdout).toMatch(/Видалено гостьових контактів: \d+/)
    expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
  })

  it('RET6: повторний запуск того самого дня — безпечний no-op, exit 0', async () => {
    const env = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      DIRECT_DATABASE_URL: testDatabaseUrl(),
    }

    await guestContactWithReturnedLoan(91)
    await execFileAsync('node', [CLI_PATH], { env })

    const second = await execFileAsync('node', [CLI_PATH], { env })

    expect(second.stdout).toContain('Видалено гостьових контактів: 0')
  })

  it('exit ненульовий і не висить при недоступній БД — жодних напівстертих даних', async () => {
    const { contactId } = await guestContactWithReturnedLoan(91)
    const badEnv = {
      ...process.env,
      DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/does-not-exist',
      DIRECT_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/does-not-exist',
    }

    // Недосяжна БД падає не миттєво: Prisma сама відмовляється чекати на транзакцію довше за
    // ~30с («Unable to start a transaction in the given time») — а `app.close()` після цього
    // спостережено таким, що на непідключеному пулі НЕ повертається взагалі (спільний
    // `PrismaService`, не власна поведінка цього CLI). Саме тому в
    // `guest-contact-retention-cleanup.ts` закриття обмежене бюджетом (`CLOSE_BUDGET_MS`,
    // затверджена PO shutdown policy) і процес примусово завершується через `io.forceExit` —
    // інакше цей самий тест ловив би не «чистий» `exit 1`, а SIGTERM від `execFile`.
    let failure: { code: number; stdout: string; stderr: string } | undefined

    try {
      await execFileAsync('node', [CLI_PATH], { env: badEnv, timeout: 45_000 })
    } catch (error) {
      failure = error as typeof failure
    }

    expect(failure).toBeDefined()
    expect(failure?.code).toBe(1)
    expect(failure?.stdout ?? '').toBe('') // успіх НЕ друкується — закриття не підтверджене

    // Runbook обіцяє відсутність PII/SQL у виводі — тут прямо перевіряємо, що збій друкує лише
    // клас помилки (`describeFailure`, `guest-contact-retention-cleanup.ts`), а не сирий
    // `.message`/`.stack`: жодного SQL-ключового слова, жодних облікових даних із `badEnv.
    // DATABASE_URL`, жоден рядок стека виклику (`at …`).
    const stderr = failure?.stderr ?? ''

    expect(stderr).toMatch(/Тип помилки: /)
    expect(stderr).toMatch(/Закриття ресурсів не завершилося за \d+ мс — примусове завершення/)
    expect(stderr).not.toContain('invalid:invalid')
    expect(stderr).not.toContain('does-not-exist')
    expect(stderr.toUpperCase()).not.toContain('SELECT')
    expect(stderr.toUpperCase()).not.toContain('FROM "EXTERNALBORROWER"')
    expect(stderr).not.toMatch(/^\s*at /m)

    // Жодна мутація не могла статися проти СПРАВЖНЬОЇ тестової БД — підключення до неї й не було.
    expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
  }, 50_000)

  it('exit 1 без зависання й без сирого стека при збої створення контексту (невалідний DATABASE_URL)', async () => {
    // На відміну від недосяжної БД вище (валідний URL, немає слухача) — тут URL синтаксично
    // невалідний: `validateEnv` кидає ще до будь-якої спроби підключення (`NestFactory.
    // createApplicationContext` з `abortOnError: false`, guest-contact-retention-cleanup.ts).
    // Без цього прапорця NestJS сам викликає `process.exit(1)` зсередини свого bootstrap
    // (`ExceptionsZone`) МОВЧКИ, до того, як `executeCleanupRun` взагалі побачить помилку —
    // спостережено вручну під час діагностики цього шляху; цей тест ловить регресію.
    const badEnv = {
      ...process.env,
      DATABASE_URL: 'not-a-valid-url',
      DIRECT_DATABASE_URL: 'not-a-valid-url',
    }

    let failure: { code: number; stdout: string; stderr: string } | undefined

    try {
      await execFileAsync('node', [CLI_PATH], { env: badEnv, timeout: 15_000 })
    } catch (error) {
      failure = error as typeof failure
    }

    expect(failure).toBeDefined()
    expect(failure?.code).toBe(1)
    expect(failure?.stdout ?? '').toBe('')

    const stderr = failure?.stderr ?? ''

    expect(stderr).toContain('Не вдалося ініціалізувати контекст застосунку')
    expect(stderr).toMatch(/Тип помилки: /)
    expect(stderr).not.toContain('not-a-valid-url')
    expect(stderr.toUpperCase()).not.toContain('SELECT')
    expect(stderr).not.toMatch(/^\s*at /m)
  })

  it('прибирає контакт з активною позикою лише коли вона реально закрита — активна не видаляється жодним проходом', async () => {
    const graph = await createGraph(prisma)
    const contact = await prisma.externalBorrower.create({
      data: { ownerId: graph.ownerId, alias: 'CLI Active Alias', ownerInformedAt: new Date() },
    })

    await prisma.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: null,
        borrowerKind: 'GUEST',
        origin: 'RECORDED_GUEST',
        borrowerContactId: contact.id,
        status: 'HANDED_OVER',
        requestedAt: null,
        handedAt: new Date(),
      },
    })
    await prisma.externalBorrower.update({ where: { id: contact.id }, data: { retainUntil: null } })

    const env = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      DIRECT_DATABASE_URL: testDatabaseUrl(),
    }

    await execFileAsync('node', [CLI_PATH], { env })
    await execFileAsync('node', [CLI_PATH], { env }) // повторний прохід — той самий результат

    const row = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contact.id } })

    expect(row.retainUntil).toBeNull()
  })
})
