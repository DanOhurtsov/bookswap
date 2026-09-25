import 'reflect-metadata'
import request from 'supertest'
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
import { NotificationDigestService } from '../src/notifications/notification-digest.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10a (docs/plan/stage-10-real-world-history.md, §8): читачі Copy/Loan мусять
 * безпечно витримувати nullable `Loan.borrowerId`/`Copy.currentHolderId`. Гостьових записів API
 * ще не створює, тож стан «книжка в гостя» виставляється напряму в БД — рівно так, як його
 * зустріне код, коли 10f додасть цю функцію.
 */
describe('Stage 10 (10a): читачі й гостьовий стан у БД (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  let friend: Account
  let shelf: Shelf
  let loanId: string

  const get = (account: Account, path: string): request.Test =>
    request(app.getHttpServer()).get(url(path)).set('Cookie', account.cookie)

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 's10-owner')
    friend = await registerAccount(app, 's10-friend')

    await befriend(app, owner, friend)
    shelf = await createShelfCopy(app, owner)

    const contact = await prisma.externalBorrower.create({
      data: { ownerId: owner.id, alias: 'синтетичний гість' },
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
          handedAt: new Date('2026-01-10T10:00:00Z'),
          dueAt: new Date('2026-02-01T23:59:59Z'),
        },
      }),
    ])

    loanId = (await prisma.loan.findFirstOrThrow({ where: { copyId: shelf.copyId } })).id
  })

  afterAll(async () => {
    await app.close()
  })

  it('«Мої не вдома» і моя бібліотека містять книжку в гостя — без тримача-користувача', async () => {
    const out = await get(owner, '/me/library/out').expect(200)
    const copies = (
      out.body as { groups: { copies: { id: string; isHome: boolean; holder: unknown }[] }[] }
    ).groups.flatMap((group) => group.copies)

    expect(copies).toEqual([
      expect.objectContaining({ id: shelf.copyId, isHome: false, holder: null }),
    ])

    const own = await get(owner, '/me/library').expect(200)
    const groups = (
      own.body as { groups: { counts: { total: number; home: number; out: number } }[] }
    ).groups

    expect(groups.map((group) => group.counts)).toContainEqual({ total: 1, home: 0, out: 1 })
  })

  it('друг бачить «не вдома» без імені тримача навіть при showHolderNames = true і не може просити', async () => {
    const response = await get(friend, `/users/${owner.id}/library`).expect(200)
    const copy = (response.body as { groups: { copies: Record<string, unknown>[] }[] }).groups[0]
      ?.copies[0]

    expect(copy).toMatchObject({ id: shelf.copyId, isHome: false, holder: null, canRequest: false })
    expect(JSON.stringify(response.body)).not.toContain('синтетичний гість')
  })

  it('/loans не падає й не віддає гостьову позику; /loans/:id — 404', async () => {
    const list = await get(owner, '/loans').expect(200)

    expect((list.body as { loans: unknown[] }).loans).toEqual([])
    await get(owner, `/loans/${loanId}`).expect(404)
    await request(app.getHttpServer())
      .patch(url(`/loans/${loanId}`))
      .set('Cookie', owner.cookie)
      .send({ action: 'return' })
      .expect(404)
  })

  it('історія примірника й твору: гостьова позика анонімна для всіх, без ключів особи', async () => {
    for (const viewer of [owner, friend]) {
      const byCopy = await get(viewer, `/copies/${shelf.copyId}/history`).expect(200)
      const byWork = await get(viewer, `/works/${shelf.workId}/history`).expect(200)
      const raw = JSON.stringify([byCopy.body, byWork.body])

      expect((byCopy.body as { entries: { names: boolean }[] }).entries).toEqual([
        expect.objectContaining({ names: false, status: 'HANDED_OVER', requestedAt: null }),
      ])
      expect(raw).not.toContain('синтетичний гість')
      expect(raw).not.toContain('borrower')
    }
  })

  it('«Моя історія» не падає; гостьова позика в ній з’явиться разом з аліасом у 10f', async () => {
    const mine = await get(owner, '/me/history').expect(200)

    expect(mine.body).toMatchObject({ borrowed: [], lent: [] })
  })

  it('щоденна задача не падає на прострочені гостьові позики й нікому нічого не шле', async () => {
    const digest = app.get(NotificationDigestService)
    const count = (): Promise<number> =>
      prisma.notification.count({
        where: {
          userId: { in: [owner.id, friend.id] },
          type: { in: ['LOAN_OVERDUE', 'LOAN_DUE_SOON'] },
        },
      })
    const before = await count()

    // dueAt гостьової позики (2026-02-01) відносно цієї дати вже в минулому — була б прострочена.
    await digest.run(new Date('2026-06-01T12:00:00Z'))

    expect(await count()).toBe(before)
  })
})

/**
 * Межа request-flow API (10a): позика з `origin ≠ REQUESTED` не належить `/loans`, навіть коли має
 * зареєстрованого позичальника й ненульовий `requestedAt` (дефолт БД). Її створюють кроки 10e/10f.
 */
describe('Stage 10 (10a): /loans приймає лише origin = REQUESTED (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  it('записана власником позика (RECORDED_EXISTING, REGISTERED, requestedAt за дефолтом) недоступна: список, GET, PATCH', async () => {
    const owner = await registerAccount(app, 's10b-owner')
    const borrower = await registerAccount(app, 's10b-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const foreign = await prisma.loan.create({
      data: {
        copyId: shelf.copyId,
        ownerId: owner.id,
        borrowerId: borrower.id,
        origin: 'RECORDED_EXISTING',
        status: 'REQUESTED',
      },
    })

    expect(foreign.requestedAt).not.toBeNull()

    for (const account of [owner, borrower]) {
      const list = await request(app.getHttpServer())
        .get(url('/loans'))
        .set('Cookie', account.cookie)
        .expect(200)

      expect((list.body as { loans: unknown[] }).loans).toEqual([])

      await request(app.getHttpServer())
        .get(url(`/loans/${foreign.id}`))
        .set('Cookie', account.cookie)
        .expect(404)
    }

    await actOnLoan(app, owner, foreign.id, { action: 'approve' }).expect(404)
    await actOnLoan(app, borrower, foreign.id, { action: 'cancel' }).expect(404)

    const after = await prisma.loan.findUniqueOrThrow({ where: { id: foreign.id } })
    const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

    expect(after.status).toBe('REQUESTED')
    expect(copy.status).toBe('AVAILABLE')
  })

  it('чужий origin не блокує Copy: звичайна позика на тому ж примірнику проходить чинний сценарій', async () => {
    const owner = await registerAccount(app, 's10b2-owner')
    const borrower = await registerAccount(app, 's10b2-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)

    await prisma.loan.create({
      data: {
        copyId: shelf.copyId,
        ownerId: owner.id,
        borrowerId: borrower.id,
        origin: 'RECORDED_EXISTING',
        status: 'REJECTED',
      },
    })

    const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
    const loanId = (created.body as { loan: { id: string } }).loan.id

    await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
    await actOnLoan(app, borrower, loanId, { action: 'hand_over' }).expect(200)

    const list = await request(app.getHttpServer())
      .get(url('/loans'))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect((list.body as { loans: { id: string; status: string }[] }).loans).toEqual([
      expect.objectContaining({ id: loanId, status: 'HANDED_OVER' }),
    ])
  })
})
