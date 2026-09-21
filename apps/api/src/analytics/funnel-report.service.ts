import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { computeDedupeKey } from './dedupe-key'
import {
  calculateFunnelReport,
  compareDedupeKeys,
  summarizeBookAddedMethods,
  type FunnelReport,
  type FunnelReportQuery,
} from './funnel-report'
import { PRODUCT_EVENT_TYPE, productEventTypeSchema } from './product-event.types'

const CONVERSION_EVENT_TYPES = PRODUCT_EVENT_TYPE.filter((type) => type !== 'SIGNUP_COMPLETED')
const DAY_MS = 24 * 60 * 60 * 1000

@Injectable()
export class FunnelReportService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(query: FunnelReportQuery): Promise<FunnelReport> {
    const earliest = await this.prisma.productEvent.aggregate({ _min: { occurredAt: true } })

    if (earliest._min.occurredAt === null) {
      return calculateFunnelReport({
        ...query,
        earliestEventAt: null,
        signups: [],
        events: [],
        crossCheck: { eventOnly: 0, domainOnly: 0 },
        bookAddedByMethod: summarizeBookAddedMethods([]),
      })
    }

    const [signups, bookEvents, copies] = await Promise.all([
      this.prisma.productEvent.findMany({
        where: {
          type: 'SIGNUP_COMPLETED',
          occurredAt: { gte: query.from, lt: query.toExclusive },
        },
        select: { subjectUserId: true, occurredAt: true },
      }),
      this.prisma.productEvent.findMany({
        where: { type: 'BOOK_ADDED', occurredAt: { gte: query.from, lt: query.toExclusive } },
        // 8h-3: той самий запит, що живив cross-check, тепер несе ще й
        // `properties` — щоб розподіл за методом рахувався рівно за той самий
        // період і рівно за ті самі рядки, без другого читання таблиці.
        select: { dedupeKey: true, properties: true },
      }),
      this.prisma.copy.findMany({
        where: { createdAt: { gte: query.from, lt: query.toExclusive } },
        select: { id: true, ownerId: true },
      }),
    ])
    const subjectIds = [
      ...new Set(
        signups.flatMap((signup) => (signup.subjectUserId === null ? [] : [signup.subjectUserId])),
      ),
    ]
    const events =
      subjectIds.length === 0
        ? []
        : await this.prisma.productEvent.findMany({
            where: {
              subjectUserId: { in: subjectIds },
              type: { in: [...CONVERSION_EVENT_TYPES] },
              occurredAt: {
                gte: query.from,
                lte: new Date(query.toExclusive.getTime() + query.windowDays * DAY_MS),
              },
            },
            select: { type: true, subjectUserId: true, occurredAt: true },
          })

    return calculateFunnelReport({
      ...query,
      earliestEventAt: earliest._min.occurredAt,
      signups,
      events: events.map((event) => ({
        ...event,
        type: productEventTypeSchema.parse(event.type),
      })),
      crossCheck: compareDedupeKeys(
        bookEvents.map((event) => event.dedupeKey),
        copies.map((copy) => computeDedupeKey('BOOK_ADDED', copy.id, copy.ownerId)),
      ),
      bookAddedByMethod: summarizeBookAddedMethods(bookEvents.map((event) => event.properties)),
    })
  }
}
