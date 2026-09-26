import { computeDedupeKey } from '../../src/analytics/dedupe-key'
import { createGraph, createUser } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'
import type { PrismaClient } from '../../src/generated/prisma/client'

/**
 * docs/plan/stage-8-activation.md, §11 — DB-тести для ProductEvent (§1, §2).
 * `ProductEvent` не входить у список `TABLES` (test-database.ts), але
 * `truncateAll` однаково спорожняє й її: `TRUNCATE ... CASCADE` на `User`
 * автоматично каскадить на будь-яку таблицю з FK на неї, включно з
 * `ProductEvent`, незалежно від того, що сама вона в списку не названа.
 */
describe('ProductEvent (§2, §11)', () => {
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

  it('таблиця, unique constraint і обидва індекси існують', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'ProductEvent'
      ORDER BY indexname
    `

    const names = indexes.map((index) => index.indexname)
    expect(names).toContain('ProductEvent_dedupeKey_key')
    expect(names).toContain('ProductEvent_type_occurredAt_idx')
    expect(names).toContain('ProductEvent_subjectUserId_type_idx')

    const dedupeIndex = indexes.find((index) => index.indexname === 'ProductEvent_dedupeKey_key')
    expect(dedupeIndex?.indexdef).toMatch(/CREATE UNIQUE INDEX/)

    const typeOccurredAt = indexes.find(
      (index) => index.indexname === 'ProductEvent_type_occurredAt_idx',
    )
    expect(typeOccurredAt?.indexdef).toMatch(/\(type, "occurredAt"\)/)

    const subjectType = indexes.find(
      (index) => index.indexname === 'ProductEvent_subjectUserId_type_idx',
    )
    expect(subjectType?.indexdef).toMatch(/\("subjectUserId", type\)/)
  })

  it('FK subjectUserId → User має ON DELETE SET NULL', async () => {
    const rows = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"ProductEvent"'::regclass
        AND contype = 'f'
        AND conname = 'ProductEvent_subjectUserId_fkey'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]?.definition).toMatch(/REFERENCES "User"\(id\)/)
    expect(rows[0]?.definition).toMatch(/ON DELETE SET NULL/)
  })

  it('видалення User встановлює subjectUserId = NULL і не видаляє ProductEvent', async () => {
    const userId = await createUser(prisma)
    const event = await prisma.productEvent.create({
      data: {
        type: 'SIGNUP_COMPLETED',
        properties: {},
        dedupeKey: computeDedupeKey('SIGNUP_COMPLETED', userId, userId),
        subjectUserId: userId,
      },
    })

    await prisma.user.delete({ where: { id: userId } })

    const survived = await prisma.productEvent.findUniqueOrThrow({ where: { id: event.id } })
    expect(survived.subjectUserId).toBeNull()
  })

  /**
   * §1: обґрунтування всієї моделі — Copy без історії позичань може бути незворотно
   * видалений (`LibraryService.removeCopy`), а BOOK_ADDED мусить пережити це
   * структурно, без FK на Copy взагалі.
   */
  it('видалення Copy не видаляє й не чіпає ProductEvent (немає FK на Copy)', async () => {
    const graph = await createGraph(prisma)
    const event = await prisma.productEvent.create({
      data: {
        type: 'BOOK_ADDED',
        properties: { method: 'MANUAL' },
        dedupeKey: computeDedupeKey('BOOK_ADDED', graph.copyId, graph.ownerId),
        subjectUserId: graph.ownerId,
      },
    })

    await prisma.copy.delete({ where: { id: graph.copyId } })

    const survived = await prisma.productEvent.findUniqueOrThrow({ where: { id: event.id } })
    expect(survived.subjectUserId).toBe(graph.ownerId)
    expect(survived.type).toBe('BOOK_ADDED')
  })

  it('видалення Loan не чіпає ProductEvent (немає FK на Loan)', async () => {
    const graph = await createGraph(prisma)
    const loan = await prisma.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: graph.borrowerId,
        status: 'RETURNED',
      },
    })
    const event = await prisma.productEvent.create({
      data: {
        type: 'LOAN_RETURNED',
        properties: {},
        dedupeKey: computeDedupeKey('LOAN_RETURNED', loan.id, graph.borrowerId),
        subjectUserId: graph.borrowerId,
      },
    })

    await prisma.loan.delete({ where: { id: loan.id } })

    expect(await prisma.productEvent.findUnique({ where: { id: event.id } })).not.toBeNull()
  })

  it('видалення Friendship не чіпає ProductEvent (немає FK на Friendship)', async () => {
    const [userAId, userBId] = [await createUser(prisma), await createUser(prisma)].sort()
    if (userAId === undefined || userBId === undefined) throw new Error('Недосяжно')

    const friendship = await prisma.friendship.create({
      data: { userAId, userBId, requestedById: userAId, status: 'ACCEPTED' },
    })
    const event = await prisma.productEvent.create({
      data: {
        type: 'FRIEND_ACCEPTED',
        properties: {},
        dedupeKey: computeDedupeKey('FRIEND_ACCEPTED', friendship.id, userAId),
        subjectUserId: userAId,
      },
    })

    await prisma.friendship.delete({ where: { id: friendship.id } })

    expect(await prisma.productEvent.findUnique({ where: { id: event.id } })).not.toBeNull()
  })

  it('schemaVersion за замовчуванням 1', async () => {
    const userId = await createUser(prisma)
    const event = await prisma.productEvent.create({
      data: {
        type: 'SIGNUP_COMPLETED',
        properties: {},
        dedupeKey: computeDedupeKey('SIGNUP_COMPLETED', userId, userId),
        subjectUserId: userId,
      },
    })

    expect(event.schemaVersion).toBe(1)
  })

  it('occurredAt заповнюється автоматично', async () => {
    const userId = await createUser(prisma)
    const before = new Date()
    const event = await prisma.productEvent.create({
      data: {
        type: 'SIGNUP_COMPLETED',
        properties: {},
        dedupeKey: computeDedupeKey('SIGNUP_COMPLETED', userId, userId),
        subjectUserId: userId,
      },
    })

    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  })

  it('duplicate dedupeKey не створює другий рядок (createMany + skipDuplicates)', async () => {
    const userId = await createUser(prisma)
    const dedupeKey = computeDedupeKey('SIGNUP_COMPLETED', userId, userId)
    const data = { type: 'SIGNUP_COMPLETED', properties: {}, dedupeKey, subjectUserId: userId }

    await prisma.productEvent.createMany({ data: [data], skipDuplicates: true })
    await prisma.productEvent.createMany({ data: [data], skipDuplicates: true })

    expect(await prisma.productEvent.count({ where: { dedupeKey } })).toBe(1)
  })

  it('duplicate dedupeKey через звичайний create падає з унікальним порушенням', async () => {
    const userId = await createUser(prisma)
    const dedupeKey = computeDedupeKey('SIGNUP_COMPLETED', userId, userId)
    const data = { type: 'SIGNUP_COMPLETED', properties: {}, dedupeKey, subjectUserId: userId }

    await prisma.productEvent.create({ data })

    await expect(prisma.productEvent.create({ data })).rejects.toThrow(/Unique constraint/)
  })
})
