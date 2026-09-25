import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { loanResponseSchema } from '@bookswap/shared'
import type { App } from 'supertest/types'
import { AnalyticsService } from '../src/analytics/analytics.service'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import type { ProductEventType } from '../src/analytics/product-event.types'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  type Account,
} from './loan.helpers'

const LOAN_EVENT_TYPES = [
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_HANDED_OVER',
  'LOAN_RETURNED',
] as const satisfies readonly ProductEventType[]

describe('Friend and loan product analytics (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  async function pair(): Promise<{ owner: Account; borrower: Account }> {
    return {
      owner: await registerAccount(app, 'analytics-owner'),
      borrower: await registerAccount(app, 'analytics-borrower'),
    }
  }

  it('records FRIEND_ACCEPTED for both users only after the friendship commit', async () => {
    const { owner, borrower } = await pair()
    const analytics = app.get(AnalyticsService)
    const originalRecord = analytics.record.bind(analytics)
    const record = jest.spyOn(analytics, 'record').mockImplementation(async (input) => {
      expect(input.type).toBe('FRIEND_ACCEPTED')
      await expect(
        prisma.friendship.findUnique({ where: { id: input.domainEntityId } }),
      ).resolves.toMatchObject({ status: 'ACCEPTED' })
      await originalRecord(input)
    })

    await befriend(app, owner, borrower)

    const friendship = await prisma.friendship.findFirstOrThrow({
      where: { OR: [{ userAId: owner.id }, { userBId: owner.id }], status: 'ACCEPTED' },
    })
    const events = await prisma.productEvent.findMany({
      where: {
        type: 'FRIEND_ACCEPTED',
        subjectUserId: { in: [owner.id, borrower.id] },
      },
    })

    expect(record).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(2)

    for (const subjectUserId of [owner.id, borrower.id]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          subjectUserId,
          properties: {},
          schemaVersion: 1,
          dedupeKey: computeDedupeKey('FRIEND_ACCEPTED', friendship.id, subjectUserId),
        }),
      )
    }
  })

  it('records the complete loan lifecycle for the borrower after each commit', async () => {
    const { owner, borrower } = await pair()
    await befriend(app, owner, borrower)
    const shelf = await createShelfCopy(app, owner)
    const analytics = app.get(AnalyticsService)
    const originalRecord = analytics.record.bind(analytics)
    const statusByType = {
      LOAN_REQUESTED: 'REQUESTED',
      LOAN_APPROVED: 'APPROVED',
      LOAN_HANDED_OVER: 'HANDED_OVER',
      LOAN_RETURNED: 'RETURNED',
    } as const
    const record = jest.spyOn(analytics, 'record').mockImplementation(async (input) => {
      if (input.type in statusByType) {
        await expect(
          prisma.loan.findUnique({ where: { id: input.domainEntityId } }),
        ).resolves.toMatchObject({ status: statusByType[input.type as keyof typeof statusByType] })
      }

      await originalRecord(input)
    })

    const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
    const loanId = loanResponseSchema.parse(created.body).loan.id
    await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
    await actOnLoan(app, borrower, loanId, { action: 'hand_over' }).expect(200)
    await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

    const events = await prisma.productEvent.findMany({
      where: { subjectUserId: borrower.id, type: { in: [...LOAN_EVENT_TYPES] } },
    })

    expect(record).toHaveBeenCalledTimes(4)
    expect(events).toHaveLength(4)
    expect(events.map((event) => event.type).sort()).toEqual([...LOAN_EVENT_TYPES].sort())

    for (const event of events) {
      expect(event).toMatchObject({
        subjectUserId: borrower.id,
        properties: {},
        schemaVersion: 1,
        dedupeKey: computeDedupeKey(event.type as ProductEventType, loanId, borrower.id),
      })
    }

    await expect(
      prisma.productEvent.count({
        where: { subjectUserId: owner.id, type: { in: [...LOAN_EVENT_TYPES] } },
      }),
    ).resolves.toBe(0)
  })

  it('does not invent events for rejected, cancelled, lost, or auto-rejected loans', async () => {
    const { owner, borrower } = await pair()
    const rival = await registerAccount(app, 'analytics-rival')
    await befriend(app, owner, borrower)
    await befriend(app, owner, rival)
    const shelf = await createShelfCopy(app, owner)

    const first = loanResponseSchema.parse(
      (await requestLoan(app, borrower, shelf.copyId).expect(201)).body,
    ).loan.id
    const rivalLoan = loanResponseSchema.parse(
      (await requestLoan(app, rival, shelf.copyId).expect(201)).body,
    ).loan.id
    await actOnLoan(app, owner, first, { action: 'approve' }).expect(200)
    await actOnLoan(app, owner, first, { action: 'cancel' }).expect(200)

    const rejected = loanResponseSchema.parse(
      (await requestLoan(app, borrower, shelf.copyId).expect(201)).body,
    ).loan.id
    await actOnLoan(app, owner, rejected, { action: 'reject' }).expect(200)

    const lost = loanResponseSchema.parse(
      (await requestLoan(app, borrower, shelf.copyId).expect(201)).body,
    ).loan.id
    await actOnLoan(app, owner, lost, { action: 'approve' }).expect(200)
    await actOnLoan(app, borrower, lost, { action: 'hand_over' }).expect(200)
    await actOnLoan(app, owner, lost, { action: 'mark_lost' }).expect(200)

    await expect(prisma.loan.findUnique({ where: { id: rivalLoan } })).resolves.toMatchObject({
      status: 'REJECTED',
    })

    const events = await prisma.productEvent.findMany({
      where: {
        subjectUserId: { in: [borrower.id, rival.id] },
        type: { in: [...LOAN_EVENT_TYPES] },
      },
      select: { dedupeKey: true },
    })
    const expectedKeys = [
      computeDedupeKey('LOAN_REQUESTED', first, borrower.id),
      computeDedupeKey('LOAN_APPROVED', first, borrower.id),
      computeDedupeKey('LOAN_REQUESTED', rivalLoan, rival.id),
      computeDedupeKey('LOAN_REQUESTED', rejected, borrower.id),
      computeDedupeKey('LOAN_REQUESTED', lost, borrower.id),
      computeDedupeKey('LOAN_APPROVED', lost, borrower.id),
      computeDedupeKey('LOAN_HANDED_OVER', lost, borrower.id),
    ].sort()

    expect(events.map((event) => event.dedupeKey).sort()).toEqual(expectedKeys)
  })

  it('keeps every friend and loan mutation successful when analytics storage fails', async () => {
    const { owner, borrower } = await pair()
    const shelf = await createShelfCopy(app, owner)
    const createMany = jest
      .spyOn(prisma.productEvent, 'createMany')
      .mockRejectedValue(new Error('Simulated analytics storage failure'))

    await befriend(app, owner, borrower)
    const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
    const loanId = loanResponseSchema.parse(created.body).loan.id
    await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
    await actOnLoan(app, borrower, loanId, { action: 'hand_over' }).expect(200)
    const returned = await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

    expect(loanResponseSchema.parse(returned.body).loan.status).toBe('RETURNED')
    // 2× FRIEND_ACCEPTED + FRIEND_INVENTORY_USABLE (у друга є видима доступна книжка) + 4 події лоану.
    expect(createMany).toHaveBeenCalledTimes(7)
    await expect(
      prisma.friendship.findFirst({
        where: { OR: [{ userAId: owner.id }, { userBId: owner.id }] },
      }),
    ).resolves.toMatchObject({ status: 'ACCEPTED' })
    await expect(
      prisma.productEvent.count({
        where: {
          subjectUserId: { in: [owner.id, borrower.id] },
          type: { in: ['FRIEND_ACCEPTED', ...LOAN_EVENT_TYPES] },
        },
      }),
    ).resolves.toBe(0)
  })
})
