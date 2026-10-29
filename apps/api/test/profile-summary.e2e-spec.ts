import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import { profileSummarySchema, type ProfileSummary } from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
  requestLoan,
  url,
  type Account,
} from './loan.helpers'

const DAY_MS = 86_400_000

/**
 * BS-148, sub-stage E: `GET /me/profile-summary` — end to end. Counts, the latest books with where
 * each one is, friends, «Надійність» as a borrower, and activity read from loan timestamps.
 */
describe('Зведення профілю (e2e, BS-148)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  async function summaryOf(account: Account): Promise<ProfileSummary> {
    const response = await request(app.getHttpServer())
      .get(url('/me/profile-summary'))
      .set('Cookie', account.cookie)
      .expect(200)

    return profileSummarySchema.parse(response.body)
  }

  it('без сесії — 401', async () => {
    await request(app.getHttpServer()).get(url('/me/profile-summary')).expect(401)
  })

  it('новий акаунт: нулі, порожні списки, середнього терміну ще немає', async () => {
    const newcomer = await registerAccount(app, 'summary-new')

    expect(await summaryOf(newcomer)).toEqual({
      stats: { copies: 0, friends: 0, lentLoans: 0, wishlist: 0 },
      reliability: { returnedOnTime: 0, returnedWithDue: 0, averageLoanDays: null, outNow: 0 },
      books: { items: [], total: 0 },
      friends: { items: [], total: 0 },
      activity: [],
    })
  })

  it('власник бачить, де кожна книжка, друзів і останні події', async () => {
    const owner = await registerAccount(app, 'summary-owner')
    const friend = await registerAccount(app, 'summary-friend')

    await befriend(app, owner, friend)

    const lent = await createShelfCopy(app, owner)
    const requested = await createShelfCopy(app, owner)
    const home = await createShelfCopy(app, owner)
    const lentLoanId = await handedOverLoan(app, owner, friend, lent.copyId)
    const requestedLoan = await requestLoan(app, friend, requested.copyId).expect(201)
    const requestedLoanId = (requestedLoan.body as { loan: { id: string } }).loan.id

    await request(app.getHttpServer())
      .post(url('/me/wishlist'))
      .set('Cookie', owner.cookie)
      .send({ workId: lent.workId })
      .expect(200)

    const summary = await summaryOf(owner)
    // `toMatchObject` below: a person is matched by id, the rest of `PublicUser` is not the point here.
    const friendRef = { kind: 'USER', user: { id: friend.id } }

    expect(summary.stats).toEqual({ copies: 3, friends: 1, lentLoans: 1, wishlist: 1 })
    expect(summary.reliability).toEqual({
      returnedOnTime: 0,
      returnedWithDue: 0,
      averageLoanDays: null,
      outNow: 1,
    })
    // Newest first.
    expect(summary.books.items.map((book) => [book.copyId, book.place])).toMatchObject([
      [home.copyId, { kind: 'HOME' }],
      [requested.copyId, { kind: 'HOME_REQUESTED', pendingRequestCount: 1 }],
      [lent.copyId, { kind: 'LENT', holder: friendRef, dueAt: null, overdue: false }],
    ])
    expect(summary.books.total).toBe(3)
    expect(summary.friends).toMatchObject({ items: [{ id: friend.id }], total: 1 })
    expect(summary.friends.items).toHaveLength(1)
    expect(
      summary.activity.map((line) =>
        line.kind === 'LOAN' ? [line.event, line.loanId, line.role] : [line.kind, line.count],
      ),
    ).toEqual([
      ['REQUESTED', requestedLoanId, 'OWNER'],
      ['HANDED_OVER', lentLoanId, 'OWNER'],
      ['APPROVED', lentLoanId, 'OWNER'],
      ['REQUESTED', lentLoanId, 'OWNER'],
      ['COPIES_ADDED', 3],
    ])
    expect(summary.activity[0]).toMatchObject({ counterpart: friendRef })
  })

  it('позичальник бачить ту саму позику зі свого боку', async () => {
    const owner = await registerAccount(app, 'summary-owner')
    const borrower = await registerAccount(app, 'summary-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)
    const summary = await summaryOf(borrower)

    expect(summary.stats).toMatchObject({ copies: 0, lentLoans: 0 })
    expect(summary.books.items).toEqual([])
    expect(summary.activity[0]).toMatchObject({
      kind: 'LOAN',
      event: 'HANDED_OVER',
      loanId,
      role: 'BORROWER',
      counterpart: { kind: 'USER', user: { id: owner.id } },
      work: { id: shelf.workId },
    })
  })

  it('надійність: вчасно — до кінця дня терміну; без терміну — лише в середньому', async () => {
    const owner = await registerAccount(app, 'summary-owner')
    const borrower = await registerAccount(app, 'summary-borrower')

    await befriend(app, owner, borrower)

    const returned: string[] = []

    for (let index = 0; index < 3; index += 1) {
      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)
      returned.push(loanId)
    }

    const handedAt = new Date('2026-09-01T10:00:00.000Z')
    const [onTime, late, noDue] = returned
    const at = (days: number) => new Date(handedAt.getTime() + days * DAY_MS)

    await prisma.$transaction([
      // Returned on the due day itself, in the evening: still on time (`toDueDate` = end of day).
      prisma.loan.update({
        where: { id: onTime },
        data: {
          handedAt,
          dueAt: new Date('2026-09-11T23:59:59.999Z'),
          returnedAt: new Date('2026-09-11T20:00:00.000Z'),
        },
      }),
      prisma.loan.update({
        where: { id: late },
        data: { handedAt, dueAt: at(14), returnedAt: at(20) },
      }),
      prisma.loan.update({
        where: { id: noDue },
        data: { handedAt, dueAt: null, returnedAt: at(30) },
      }),
    ])

    const summary = await summaryOf(borrower)

    // (10.4 + 20 + 30) / 3 ≈ 20.1 days.
    expect(summary.reliability).toEqual({
      returnedOnTime: 1,
      returnedWithDue: 2,
      averageLoanDays: 20,
      outNow: 0,
    })
    // The owner's numbers are about lending, not returning.
    expect((await summaryOf(owner)).stats.lentLoans).toBe(3)
    expect((await summaryOf(owner)).reliability.returnedWithDue).toBe(0)
  })

  it('гостьова позика: книжка в гостя за аліасом власника, рахується в позиках і «зараз у друзів»', async () => {
    const owner = await registerAccount(app, 'summary-guest-owner')
    const shelf = await createShelfCopy(app, owner)
    const contact = await prisma.externalBorrower.create({
      data: { ownerId: owner.id, alias: 'Сусідка Оля' },
    })

    await prisma.$transaction([
      prisma.copy.update({
        where: { id: shelf.copyId },
        data: { status: 'LENT_OUT', currentHolderId: null, heldByContactId: contact.id },
      }),
      prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: null,
          borrowerContactId: contact.id,
          borrowerKind: 'GUEST',
          origin: 'RECORDED_GUEST',
          requestedAt: null,
          status: 'HANDED_OVER',
          handedAt: new Date('2026-10-01T00:00:00.000Z'),
          dueAt: new Date('2020-01-01T23:59:59.999Z'),
        },
      }),
    ])

    const summary = await summaryOf(owner)

    expect(summary.stats.lentLoans).toBe(1)
    expect(summary.reliability.outNow).toBe(1)
    expect(summary.books.items[0]?.place).toEqual({
      kind: 'LENT',
      holder: { kind: 'GUEST', alias: 'Сусідка Оля' },
      dueAt: '2020-01-01',
      overdue: true,
    })
  })

  it('архівний примірник не рахується серед книжок і не показується', async () => {
    const owner = await registerAccount(app, 'summary-archive')
    const kept = await createShelfCopy(app, owner)
    const archived = await createShelfCopy(app, owner)

    await prisma.copy.update({ where: { id: archived.copyId }, data: { archivedAt: new Date() } })

    const summary = await summaryOf(owner)

    expect(summary.stats.copies).toBe(1)
    expect(summary.books.items.map((book) => book.copyId)).toEqual([kept.copyId])
  })
})
