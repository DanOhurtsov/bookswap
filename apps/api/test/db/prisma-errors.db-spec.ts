import { createGraph } from './fixtures'
import {
  isDeadlockOrSerializationFailure,
  isForeignKeyViolationOn,
} from '../../src/common/prisma-errors'
import { createTestPrismaClient, truncateAll } from './test-database'
import type { PrismaClient } from '../../src/generated/prisma/client'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

/**
 * Пінує не вигаданий object literal, а реальну форму 40P01, яку Prisma 7 з
 * `@prisma/adapter-pg` повертає від живої PostgreSQL. Дві незалежні транзакції
 * беруть ті самі User-рядки у протилежному порядку; JS-барʼєр гарантує, що
 * обидві вже тримають перший лок до спроби взяти другий.
 */
describe('розпізнавання retryable PostgreSQL помилок', () => {
  let setup: PrismaClient
  let workerA: PrismaClient
  let workerB: PrismaClient

  beforeAll(() => {
    setup = createTestPrismaClient()
    workerA = createTestPrismaClient()
    workerB = createTestPrismaClient()
  })

  beforeEach(async () => {
    await truncateAll(setup)
  })

  afterAll(async () => {
    await Promise.all([setup.$disconnect(), workerA.$disconnect(), workerB.$disconnect()])
  })

  it('реальний deadlock 40P01 має форму, яку впізнає bounded retry Telegram', async () => {
    const [userA, userB] = await Promise.all([
      setup.user.create({
        data: { email: 'deadlock-a@example.com', displayName: 'Deadlock A', passwordHash: 'x' },
      }),
      setup.user.create({
        data: { email: 'deadlock-b@example.com', displayName: 'Deadlock B', passwordHash: 'x' },
      }),
    ])
    const lockedA = deferred()
    const lockedB = deferred()
    const bothFirstLocks = Promise.all([lockedA.promise, lockedB.promise])

    const transactionA = workerA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userA.id} FOR UPDATE`
        lockedA.resolve()
        await bothFirstLocks
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userB.id} FOR UPDATE`
      },
      { timeout: 10_000 },
    )
    const transactionB = workerB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userB.id} FOR UPDATE`
        lockedB.resolve()
        await bothFirstLocks
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userA.id} FOR UPDATE`
      },
      { timeout: 10_000 },
    )

    const settled = await Promise.allSettled([transactionA, transactionB])
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    const fulfilled = settled.filter((result) => result.status === 'fulfilled')

    expect(rejected).toHaveLength(1)
    expect(fulfilled).toHaveLength(1)
    expect(isDeadlockOrSerializationFailure(rejected[0]?.reason)).toBe(true)
  }, 20_000)

  it('реальне порушення Loan_copyId_fkey розпізнається, чужий зовнішній ключ — ні', async () => {
    const graph = await createGraph(setup)

    await setup.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: graph.borrowerId,
        status: 'RETURNED',
      },
    })

    const error: unknown = await setup.copy
      .delete({ where: { id: graph.copyId } })
      .catch((e: unknown) => e)

    expect(isForeignKeyViolationOn(error, 'Loan_copyId_fkey')).toBe(true)
    expect(isForeignKeyViolationOn(error, 'Loan_borrowerId_fkey')).toBe(false)
  })
})
