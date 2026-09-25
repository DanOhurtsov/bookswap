import { ConfigService } from '@nestjs/config'
import { computeDedupeKey } from '../../src/analytics/dedupe-key'
import type { FunnelReportQuery } from '../../src/analytics/funnel-report'
import {
  formatFunnelReportJson,
  formatFunnelReportText,
} from '../../src/analytics/funnel-report.presenter'
import { FunnelReportService } from '../../src/analytics/funnel-report.service'
import type { ProductEventType } from '../../src/analytics/product-event.types'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { PrismaService } from '../../src/prisma/prisma.service'
import { createUser } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'

/**
 * Stage 9 (docs/plan/stage-9-network-activation.md, §2): the network steps and
 * aggregates of the funnel report, computed from real `ProductEvent` rows through
 * the real `FunnelReportService`.
 */
const QUERY: FunnelReportQuery = {
  fromDay: '2026-03-01',
  toDay: '2026-03-07',
  from: new Date('2026-03-01T00:00:00.000Z'),
  toExclusive: new Date('2026-03-08T00:00:00.000Z'),
  windowDays: 10,
}

const SIGNUP = new Date('2026-03-02T09:00:00.000Z')
const hoursAfter = (hours: number): Date => new Date(SIGNUP.getTime() + hours * 3_600_000)

describe('FunnelReportService — Stage 9 network metrics', () => {
  let prisma: PrismaClient
  let prismaService: PrismaService
  let service: FunnelReportService

  beforeAll(() => {
    prisma = createTestPrismaClient()
    prismaService = new PrismaService(new ConfigService())
    service = new FunnelReportService(prismaService)
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await prismaService.$disconnect()
  })

  async function event(
    type: ProductEventType,
    subjectUserId: string,
    entity: string,
    occurredAt: Date,
  ): Promise<void> {
    await prisma.productEvent.create({
      data: {
        type,
        properties: {},
        dedupeKey: computeDedupeKey(type, entity, subjectUserId),
        subjectUserId,
        occurredAt,
      },
    })
  }

  async function seed() {
    const inviter = await createUser(prisma, 'Запрошувач')
    const searcher = await createUser(prisma, 'Шукач')
    const holder = await createUser(prisma, 'Читач сторінки')
    const idle = await createUser(prisma, 'Без дій')

    for (const id of [inviter, searcher, holder, idle]) {
      await event('SIGNUP_COMPLETED', id, id, SIGNUP)
    }

    await event('INVITE_SENT', inviter, 'inv-1', hoursAfter(1))
    await event('INVITE_SENT', inviter, 'inv-2', hoursAfter(1))
    await event('INVITE_ACCEPTED', inviter, 'acc-1', hoursAfter(2))
    await event('FRIEND_INVENTORY_USABLE', searcher, searcher, hoursAfter(3))
    await event('DISCOVERY_SEARCHED', searcher, '2026-03-02', hoursAfter(4))
    await event('FRIEND_BOOK_FOUND', searcher, '2026-03-02', hoursAfter(4))
    await event('LOAN_REQUESTED', searcher, 'loan-1', hoursAfter(5))
    await event('WORK_HOLDERS_FOUND', holder, '2026-03-02', hoursAfter(4))
    await event('LOAN_REQUESTED', holder, 'loan-2', hoursAfter(1))

    return { inviter, searcher, holder, idle }
  }

  it('рахує кроки воронки й агрегати за когортою', async () => {
    await seed()

    const report = await service.generate(QUERY)

    expect(report.status).toBe('ok')
    if (report.status === 'empty') throw new Error('Очікувався populated report')

    const count = (key: string): number | undefined =>
      report.steps.find((step) => step.key === key)?.count

    expect(count('signup')).toBe(4)
    expect(count('invite_sent')).toBe(1)
    expect(count('invite_accepted')).toBe(1)
    expect(count('friend_inventory_became_usable')).toBe(1)
    expect(count('friend_book_found')).toBe(2)
    expect(count('loan_requested')).toBe(2)

    expect(report.network).toEqual({
      invites: { sent: 2, accepted: 1, acceptancePercent: 50 },
      discovery: {
        searchedUsers: 1,
        foundUsers: 1,
        searchToFoundPercent: 100,
        foundAnyUsers: 2,
        // Читач сторінки просив ДО того, як знайшов — у found → request не рахується.
        foundThenRequestedUsers: 1,
        foundToRequestPercent: 50,
      },
    })
  })

  it('друкує мережевий блок у text і не віддає ні id користувачів, ні сирих подій', async () => {
    const users = await seed()
    const report = await service.generate(QUERY)
    const text = formatFunnelReportText(report)
    const json = formatFunnelReportJson(report)

    expect(text).toContain('invites: sent 2, accepted 1, acceptance 50%')
    expect(text).toContain('search → found: 1 / 1')
    expect(text).not.toContain('not instrumented')

    for (const id of Object.values(users)) {
      expect(text).not.toContain(id)
      expect(json).not.toContain(id)
    }

    expect(json).not.toContain('dedupeKey')
  })
})
