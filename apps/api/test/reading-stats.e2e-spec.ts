import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  readingStatsResponseSchema,
  type ReadingStatsResponse,
  type ReadingStatus,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * BS-145 (docs/plan/bs-145-home-reading-stats.md): `GET /me/reading-stats`. Every test counts for an
 * account of its own, because the counts are absolute and the e2e files share one database.
 */
describe('BS-145: reading stats (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account

  const put = (account: Account, workId: string, status: ReadingStatus): request.Test =>
    request(app.getHttpServer())
      .put(url(`/me/reading-statuses/${workId}`))
      .set('Cookie', account.cookie)
      .send({ status })

  async function statsOf(account: Account, query = ''): Promise<ReadingStatsResponse['counts']> {
    const res = await request(app.getHttpServer())
      .get(url(`/me/reading-stats${query}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return readingStatsResponseSchema.parse(res.body).counts
  }

  const newShelf = (): Promise<Shelf> => createShelfCopy(app, owner)

  const rowsOf = (
    userId: string,
  ): Promise<{ workId: string; status: ReadingStatus; updatedAt: Date }[]> =>
    prisma.workReadingStatus.findMany({
      where: { userId },
      select: { workId: true, status: true, updatedAt: true },
      orderBy: { workId: 'asc' },
    })

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 'bs145-own')
  })

  afterAll(async () => {
    await app.close()
  })

  it('without a session it is 401 with a code', async () => {
    const res = await request(app.getHttpServer()).get(url('/me/reading-stats')).expect(401)

    expect(apiErrorSchema.parse(res.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
  })

  it('a user with no status set gets all three counts as zero', async () => {
    const reader = await registerAccount(app, 'bs145-empty')

    expect(await statsOf(reader)).toEqual({ NOT_READ: 0, READING: 0, READ: 0 })
  })

  it('counts every status, an explicit NOT_READ included; a work without a row is in no count', async () => {
    const reader = await registerAccount(app, 'bs145-all')
    const [a, b, c, d, untouched] = await Promise.all(Array.from({ length: 5 }, () => newShelf()))

    await put(reader, a!.workId, 'NOT_READ').expect(200)
    await put(reader, b!.workId, 'READING').expect(200)
    await put(reader, c!.workId, 'READ').expect(200)
    await put(reader, d!.workId, 'READ').expect(200)

    // Reading the work without a row neither creates one nor counts it.
    await request(app.getHttpServer())
      .get(url(`/me/reading-statuses/${untouched!.workId}`))
      .set('Cookie', reader.cookie)
      .expect(200)

    expect(await statsOf(reader)).toEqual({ NOT_READ: 1, READING: 1, READ: 2 })
  })

  it('a status change moves the work between counts; the same status again changes nothing', async () => {
    const reader = await registerAccount(app, 'bs145-move')
    const work = await newShelf()

    await put(reader, work.workId, 'NOT_READ').expect(200)
    expect(await statsOf(reader)).toEqual({ NOT_READ: 1, READING: 0, READ: 0 })

    await put(reader, work.workId, 'READING').expect(200)
    await put(reader, work.workId, 'READING').expect(200)
    expect(await statsOf(reader)).toEqual({ NOT_READ: 0, READING: 1, READ: 0 })
  })

  it('isolates users: each one gets their own counts, and a userId in the query is ignored', async () => {
    const one = await registerAccount(app, 'bs145-iso1')
    const two = await registerAccount(app, 'bs145-iso2')
    const [x, y] = await Promise.all([newShelf(), newShelf()])

    await put(one, x.workId, 'READ').expect(200)
    await put(two, x.workId, 'READING').expect(200)
    await put(two, y.workId, 'READING').expect(200)

    expect(await statsOf(one)).toEqual({ NOT_READ: 0, READING: 0, READ: 1 })
    expect(await statsOf(two)).toEqual({ NOT_READ: 0, READING: 2, READ: 0 })
    expect(await statsOf(one, `?userId=${two.id}`)).toEqual({ NOT_READ: 0, READING: 0, READ: 1 })
  })

  it('several editions and copies of one work count it once', async () => {
    const reader = await registerAccount(app, 'bs145-dup')
    const work = await newShelf()

    await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId: work.editionId, visibility: 'FRIENDS' })
      .expect(201)

    const second = await request(app.getHttpServer())
      .post(url(`/works/${work.workId}/editions`))
      .set('Cookie', owner.cookie)
      .send({ publisher: 'Друге видавництво', year: 2021 })
      .expect(201)

    await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({
        editionId: (second.body as { edition: { id: string } }).edition.id,
        visibility: 'FRIENDS',
      })
      .expect(201)

    // The owner has the work three times over; the reader borrowed none of it.
    await put(owner, work.workId, 'READ').expect(200)
    await put(reader, work.workId, 'READ').expect(200)

    expect(await statsOf(owner)).toEqual({ NOT_READ: 0, READING: 0, READ: 1 })
    expect(await statsOf(reader)).toEqual({ NOT_READ: 0, READING: 0, READ: 1 })
  })

  it('statuses outside the current library still count: archived, deleted, borrowed and returned', async () => {
    const lender = await registerAccount(app, 'bs145-lend')
    const keeper = await registerAccount(app, 'bs145-keep')

    await befriend(app, lender, keeper)

    const archived = await createShelfCopy(app, keeper)
    const deleted = await createShelfCopy(app, keeper)
    const lent = await createShelfCopy(app, lender)

    await put(keeper, archived.workId, 'READ').expect(200)
    await put(keeper, deleted.workId, 'NOT_READ').expect(200)

    const created = await requestLoan(app, keeper, lent.copyId).expect(201)
    const loanId = (created.body as { loan: { id: string } }).loan.id

    await actOnLoan(app, lender, loanId, { action: 'approve' }).expect(200)
    await actOnLoan(app, keeper, loanId, { action: 'hand_over' }).expect(200)
    await put(keeper, lent.workId, 'READING').expect(200)

    const before = await rowsOf(keeper.id)

    await request(app.getHttpServer())
      .post(url(`/me/library/${archived.copyId}/archive`))
      .set('Cookie', keeper.cookie)
      .expect(200)
    await request(app.getHttpServer())
      .delete(url(`/me/library/${deleted.copyId}`))
      .set('Cookie', keeper.cookie)
      .expect(204)
    await actOnLoan(app, lender, loanId, { action: 'return' }).expect(200)

    expect(await statsOf(keeper)).toEqual({ NOT_READ: 1, READING: 1, READ: 1 })
    expect(await rowsOf(keeper.id)).toEqual(before)
  })

  it('reading the stats leaves every row, its status and updatedAt untouched', async () => {
    const reader = await registerAccount(app, 'bs145-ro')
    const [a, b] = await Promise.all([newShelf(), newShelf()])

    await put(reader, a.workId, 'READING').expect(200)
    await put(reader, b.workId, 'NOT_READ').expect(200)

    const before = await rowsOf(reader.id)

    await statsOf(reader)
    await statsOf(reader)

    expect(await rowsOf(reader.id)).toEqual(before)
  })

  it('after a merge the canonical work is counted once', async () => {
    const reader = await registerAccount(app, 'bs145-merge')
    const [source, target, other] = await Promise.all([newShelf(), newShelf(), newShelf()])

    await put(reader, source.workId, 'READ').expect(200)
    await put(reader, target.workId, 'READING').expect(200)
    await put(reader, other.workId, 'READ').expect(200)
    expect(await statsOf(reader)).toEqual({ NOT_READ: 0, READING: 1, READ: 2 })

    await new MergeService(prisma).merge(source.workId, target.workId)

    // Q19: the newer row wins — READING on the target, set after READ on the source. The merged pair
    // is one work now, not two.
    const rows = await rowsOf(reader.id)

    expect(rows.map((row) => row.workId).sort()).toEqual([other.workId, target.workId].sort())
    expect(await statsOf(reader)).toEqual({ NOT_READ: 0, READING: 1, READ: 1 })
  })

  it('the number of SQL queries does not grow with the number of works', async () => {
    const few = await registerAccount(app, 'bs145-sql1')
    const many = await registerAccount(app, 'bs145-sql2')
    const works = await Promise.all(Array.from({ length: 12 }, () => newShelf()))
    const statuses: ReadingStatus[] = ['NOT_READ', 'READING', 'READ']

    await put(few, works[0]!.workId, 'READ').expect(200)

    for (const [index, work] of works.entries()) {
      await put(many, work.workId, statuses[index % 3]!).expect(200)
    }

    const spies = [
      jest.spyOn(prisma.workReadingStatus, 'groupBy'),
      jest.spyOn(prisma.workReadingStatus, 'findMany'),
      jest.spyOn(prisma.workReadingStatus, 'count'),
      jest.spyOn(prisma.work, 'findMany'),
      jest.spyOn(prisma.loan, 'findMany'),
    ]

    try {
      const callsFor = async (account: Account): Promise<number[]> => {
        for (const spy of spies) spy.mockClear()
        await statsOf(account)

        return spies.map((spy) => spy.mock.calls.length)
      }

      const one = await callsFor(few)

      expect(one).toEqual([1, 0, 0, 0, 0])
      expect(await callsFor(many)).toEqual(one)
      expect(await statsOf(many)).toEqual({ NOT_READ: 4, READING: 4, READ: 4 })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
