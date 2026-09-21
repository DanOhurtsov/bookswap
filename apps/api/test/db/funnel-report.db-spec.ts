import { ConfigService } from '@nestjs/config'
import { computeDedupeKey } from '../../src/analytics/dedupe-key'
import type { FunnelReportQuery } from '../../src/analytics/funnel-report'
import {
  formatFunnelReportJson,
  formatFunnelReportText,
} from '../../src/analytics/funnel-report.presenter'
import { FunnelReportService } from '../../src/analytics/funnel-report.service'
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client'
import { PrismaService } from '../../src/prisma/prisma.service'
import { createUser } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'

/**
 * Stage 8h-3: розподіл `BOOK_ADDED` за MANUAL / BARCODE / CSV на справжніх
 * рядках `ProductEvent`, через справжній `FunnelReportService`.
 *
 * Саме db-тест, а не mock Prisma: `properties` — нетипізований JSON-стовпець,
 * тож твердження «зламаний рядок не валить звіт» має сенс лише тоді, коли той
 * рядок реально лежить у PostgreSQL і реально повертається запитом звіту.
 */

/** Приватні значення в malformed-рядках: жодне не має з'явитися у виводі (§7). */
const SECRET_TITLE = 'PRIVATE-TITLE-db-8h3-91c4'
const SECRET_EMAIL = 'private-db-8h3@example.com'
const SECRET_ISBN = '9786177535019'

/**
 * Період звіту навмисно в минулому: `Copy.createdAt` тестових рядків — це
 * «зараз», тож у [from, toExclusive) доменних копій немає, і cross-check
 * лишається детермінованим (`domainOnly: 0`) незалежно від решти фікстур.
 */
const QUERY: FunnelReportQuery = {
  fromDay: '2026-03-01',
  toDay: '2026-03-07',
  from: new Date('2026-03-01T00:00:00.000Z'),
  toExclusive: new Date('2026-03-08T00:00:00.000Z'),
  windowDays: 10,
}

const INSIDE = new Date('2026-03-03T10:00:00.000Z')
const BEFORE = new Date('2026-02-28T23:59:59.999Z')
const AT_TO_EXCLUSIVE = new Date('2026-03-08T00:00:00.000Z')

interface EventFixture {
  properties: Prisma.InputJsonValue
  occurredAt: Date
}

const EVENTS: EventFixture[] = [
  { properties: { method: 'MANUAL' }, occurredAt: INSIDE },
  { properties: { method: 'MANUAL' }, occurredAt: INSIDE },
  { properties: { method: 'BARCODE' }, occurredAt: INSIDE },
  { properties: { method: 'CSV' }, occurredAt: INSIDE },
  { properties: { method: 'CSV' }, occurredAt: INSIDE },
  { properties: { method: 'CSV' }, occurredAt: INSIDE },
  // malformed: невідомий method, зайве поле, і взагалі не об'єкт.
  { properties: { method: 'SCANNER' }, occurredAt: INSIDE },
  { properties: { method: 'MANUAL', title: SECRET_TITLE }, occurredAt: INSIDE },
  { properties: [SECRET_EMAIL, SECRET_ISBN], occurredAt: INSIDE },
  // поза періодом: межі напівінтервалу [from, toExclusive).
  { properties: { method: 'CSV' }, occurredAt: BEFORE },
  { properties: { method: 'BARCODE' }, occurredAt: AT_TO_EXCLUSIVE },
]

describe('FunnelReportService — BOOK_ADDED method breakdown (8h-3)', () => {
  let prisma: PrismaClient
  let service: FunnelReportService
  let prismaService: PrismaService

  beforeAll(() => {
    prisma = createTestPrismaClient()
    // `use-test-database.ts` вже підмінив DATABASE_URL на охоронювану тестову базу.
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

  async function seed(): Promise<void> {
    const ownerId = await createUser(prisma, 'Власник')

    await prisma.productEvent.createMany({
      data: EVENTS.map((event, index) => ({
        type: 'BOOK_ADDED',
        properties: event.properties,
        dedupeKey: computeDedupeKey('BOOK_ADDED', `copy-${String(index)}`, ownerId),
        subjectUserId: ownerId,
        occurredAt: event.occurredAt,
      })),
    })
  }

  it('рахує MANUAL/BARCODE/CSV і invalidProperties рівно за [from, toExclusive)', async () => {
    await seed()

    const report = await service.generate(QUERY)

    expect(report.status).toBe('ok')
    if (report.status === 'empty') throw new Error('Очікувався populated report')

    expect(report.bookAddedByMethod).toEqual({
      MANUAL: 2,
      BARCODE: 1,
      CSV: 3,
      invalidProperties: 3,
    })

    // §3: сума дорівнює кількості прочитаних BOOK_ADDED — тобто рівно тих,
    // що потрапили в період, без двох рядків поза ним.
    const inPeriod = await prisma.productEvent.count({
      where: { type: 'BOOK_ADDED', occurredAt: { gte: QUERY.from, lt: QUERY.toExclusive } },
    })
    const breakdown = report.bookAddedByMethod
    expect(breakdown.MANUAL + breakdown.BARCODE + breakdown.CSV + breakdown.invalidProperties).toBe(
      inPeriod,
    )
    expect(inPeriod).toBe(EVENTS.length - 2)

    // Cross-check незмінний: події є, доменних копій у цьому періоді немає.
    expect(report.crossCheck.bookAdded).toEqual({ eventOnly: inPeriod, domainOnly: 0 })
  })

  it('malformed-рядок не валить звіт і не витікає в text чи JSON', async () => {
    await seed()

    const report = await service.generate(QUERY)
    const text = formatFunnelReportText(report)
    const json = formatFunnelReportJson(report)

    expect(text).toContain('  MANUAL: 2')
    expect(text).toContain('  BARCODE: 1')
    expect(text).toContain('  CSV: 3')
    expect(text).toContain('  invalidProperties: 3')
    expect(json).toContain('"invalidProperties": 3')

    for (const secret of [SECRET_TITLE, SECRET_EMAIL, SECRET_ISBN, 'SCANNER', 'dedupeKey']) {
      expect(text).not.toContain(secret)
      expect(json).not.toContain(secret)
    }
  })

  it('повертає всі чотири поля нулями, коли BOOK_ADDED у періоді немає', async () => {
    const userId = await createUser(prisma)
    await prisma.productEvent.create({
      data: {
        type: 'SIGNUP_COMPLETED',
        properties: {},
        dedupeKey: computeDedupeKey('SIGNUP_COMPLETED', userId, userId),
        subjectUserId: userId,
        occurredAt: INSIDE,
      },
    })

    const report = await service.generate(QUERY)

    expect(report.status).toBe('ok')
    if (report.status === 'empty') throw new Error('Очікувався populated report')

    expect(report.bookAddedByMethod).toEqual({
      MANUAL: 0,
      BARCODE: 0,
      CSV: 0,
      invalidProperties: 0,
    })
  })
})
