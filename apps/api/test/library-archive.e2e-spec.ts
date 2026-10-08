import 'reflect-metadata'
import { Client } from 'pg'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  catalogDiscoveryResponseSchema,
  copyHistoryResponseSchema,
  copyResponseSchema,
  libraryResponseSchema,
  myHistoryResponseSchema,
  visibleLibraryResponseSchema,
  workDetailResponseSchema,
  workHoldersResponseSchema,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { beginRequest, waitForBlockedBackend } from './concurrency.helpers'
import { testDatabaseUrl } from './db/test-database'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { LoanStatus } from '../src/generated/prisma/enums'

/**
 * Stage 10, крок 10c (docs/plan/stage-10-real-world-history.md, §6.5): archive / restore / безпечне
 * видалення. Тести A1–A4 і DEL1–DEL3 з §9.5; DEL4 (FK RESTRICT) — у `test/db/referential-actions.db-spec.ts`.
 */
describe('Архів і безпечне видалення примірників (e2e, 10c)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  let friend: Account
  let stranger: Account

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  beforeEach(async () => {
    owner = await registerAccount(app, 'arch-owner')
    friend = await registerAccount(app, 'arch-friend')
    stranger = await registerAccount(app, 'arch-stranger')
    await befriend(app, owner, friend)
  })

  afterAll(async () => {
    await app.close()
  })

  const http = () => app.getHttpServer()

  const archive = (account: Account, copyId: string): request.Test =>
    request(http())
      .post(url(`/me/library/${copyId}/archive`))
      .set('Cookie', account.cookie)

  const restore = (account: Account, copyId: string): request.Test =>
    request(http())
      .post(url(`/me/library/${copyId}/restore`))
      .set('Cookie', account.cookie)

  const remove = (account: Account, copyId: string): request.Test =>
    request(http())
      .delete(url(`/me/library/${copyId}`))
      .set('Cookie', account.cookie)

  async function ownLibraryCopyIds(account: Account, query = ''): Promise<string[]> {
    const response = await request(http())
      .get(url(`/me/library${query}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return libraryResponseSchema
      .parse(response.body)
      .groups.flatMap((group) => group.copies.map((copy) => copy.id))
  }

  async function loanStatuses(copyId: string): Promise<LoanStatus[]> {
    const loans = await prisma.loan.findMany({ where: { copyId }, orderBy: { id: 'asc' } })

    return loans.map((loan) => loan.status)
  }

  describe('A1: обмеження архівування', () => {
    it.each(['APPROVED', 'HANDED_OVER'] as const)(
      '%s → 409 COPY_HAS_ACTIVE_LOAN',
      async (status) => {
        const shelf = await createShelfCopy(app, owner)

        if (status === 'HANDED_OVER') await handedOverLoan(app, owner, friend, shelf.copyId)
        else {
          const created = await requestLoan(app, friend, shelf.copyId).expect(201)
          const loanId = (created.body as { loan: { id: string } }).loan.id

          await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
        }

        const response = await archive(owner, shelf.copyId).expect(409)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.COPY_HAS_ACTIVE_LOAN)
        expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toMatchObject({
          archivedAt: null,
        })
        expect(await loanStatuses(shelf.copyId)).toEqual([status])
      },
    )

    it('PENDING_CONFIRMATION → 409 COPY_HAS_ACTIVE_LOAN', async () => {
      const shelf = await createShelfCopy(app, owner)

      await prisma.copy.update({ where: { id: shelf.copyId }, data: { status: 'RESERVED' } })
      await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: friend.id,
          status: 'PENDING_CONFIRMATION',
          origin: 'RECORDED_EXISTING',
          requestedAt: null,
          handedAt: new Date('2026-01-10T00:00:00.000Z'),
        },
      })

      const response = await archive(owner, shelf.copyId).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.COPY_HAS_ACTIVE_LOAN)
    })

    it('LOST дозволено, історія лишається', async () => {
      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, friend, shelf.copyId)

      await actOnLoan(app, owner, loanId, { action: 'mark_lost' }).expect(200)
      const before = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      const response = await archive(owner, shelf.copyId).expect(200)

      expect(copyResponseSchema.parse(response.body).copy.id).toBe(shelf.copyId)

      const stored = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(stored.archivedAt).not.toBeNull()
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(before)
    })
  })

  describe('A2: архів прибирає примірник із вибірок і зберігає історію', () => {
    let shelf: Shelf
    let returnedLoanId: string

    beforeEach(async () => {
      shelf = await createShelfCopy(app, owner)
      returnedLoanId = await handedOverLoan(app, owner, friend, shelf.copyId)
      await actOnLoan(app, owner, returnedLoanId, { action: 'return' }).expect(200)
    })

    it('прибирає зі звичайної бібліотеки, показує в ?archived=true; чужий архів не бачить', async () => {
      await archive(owner, shelf.copyId).expect(200)

      expect(await ownLibraryCopyIds(owner)).not.toContain(shelf.copyId)
      expect(await ownLibraryCopyIds(owner, '?archived=true')).toEqual([shelf.copyId])
      expect(await ownLibraryCopyIds(owner, '?archived=false')).not.toContain(shelf.copyId)
      expect(await ownLibraryCopyIds(friend, '?archived=true')).toEqual([])
      expect(await ownLibraryCopyIds(stranger, '?archived=true')).toEqual([])
    })

    it('не потрапляє у «не вдома», бібліотеку друга, discovery, holders', async () => {
      const before = await request(http())
        .get(url(`/works/${shelf.workId}/holders?availability=AVAILABLE`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(workHoldersResponseSchema.parse(before.body).groups).toHaveLength(1)

      await archive(owner, shelf.copyId).expect(200)

      const holders = await request(http())
        .get(url(`/works/${shelf.workId}/holders?availability=AVAILABLE`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(workHoldersResponseSchema.parse(holders.body).groups).toEqual([])

      const friendShelf = await request(http())
        .get(url(`/users/${owner.id}/library`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(
        visibleLibraryResponseSchema
          .parse(friendShelf.body)
          .groups.flatMap((group) => group.copies.map((copy) => copy.id)),
      ).not.toContain(shelf.copyId)

      const out = await request(http())
        .get(url('/me/library/out'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(JSON.stringify(libraryResponseSchema.parse(out.body))).not.toContain(shelf.copyId)

      const discovered = await request(http())
        .get(url(`/catalog/discover?pageSize=50&q=${encodeURIComponent(`Полиця`)}`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(
        catalogDiscoveryResponseSchema
          .parse(discovered.body)
          .results.map((result) => result.work.id),
      ).not.toContain(shelf.workId)
    })

    it('не рахується в activation і в перевірці «у мене вже є» (права редагування твору)', async () => {
      // Твір створив власник, тож право редагувати йому дає не лише власний примірник; беремо друга,
      // якому право на видання дає лише наявність примірника.
      const foreignShelf = await createShelfCopy(app, stranger)
      const mine = await request(http())
        .post(url('/me/library'))
        .set('Cookie', owner.cookie)
        .send({ editionId: foreignShelf.editionId })
        .expect(201)
      const mineId = (mine.body as { copy: { id: string } }).copy.id
      const capabilities = async (): Promise<boolean> => {
        const response = await request(http())
          .get(url(`/works/${foreignShelf.workId}`))
          .set('Cookie', owner.cookie)
          .expect(200)

        return (
          workDetailResponseSchema
            .parse(response.body)
            .viewerCapabilities?.editableEditionIds.includes(foreignShelf.editionId) ?? false
        )
      }
      const activation = async (): Promise<number> => {
        const response = await request(http())
          .get(url('/me/activation'))
          .set('Cookie', owner.cookie)
          .expect(200)

        return (response.body as { ownedCopyCount: number }).ownedCopyCount
      }

      expect(await capabilities()).toBe(true)
      expect(await activation()).toBe(2)

      await archive(owner, mineId).expect(200)

      expect(await capabilities()).toBe(false)
      expect(await activation()).toBe(1)

      await restore(owner, mineId).expect(200)

      expect(await capabilities()).toBe(true)
      expect(await activation()).toBe(2)
    })

    it('історія лишається за чинними правилами видимості; стороннім архів історії не відкриває', async () => {
      const loansBefore = await prisma.loan.findMany({ where: { copyId: shelf.copyId } })

      await archive(owner, shelf.copyId).expect(200)

      expect(await prisma.loan.findMany({ where: { copyId: shelf.copyId } })).toEqual(loansBefore)

      for (const participant of [owner, friend]) {
        const response = await request(http())
          .get(url(`/copies/${shelf.copyId}/history`))
          .set('Cookie', participant.cookie)
          .expect(200)

        expect(copyHistoryResponseSchema.parse(response.body).entries).toHaveLength(1)
      }

      const mine = await request(http())
        .get(url('/me/history'))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(myHistoryResponseSchema.parse(mine.body).borrowed).toHaveLength(1)

      // Сторонній: примірник не існує для нього ні до, ні після архівування.
      await request(http())
        .get(url(`/copies/${shelf.copyId}/history`))
        .set('Cookie', stranger.cookie)
        .expect(404)
    })

    it('новий запит на архівний примірник — 404', async () => {
      await archive(owner, shelf.copyId).expect(200)

      await requestLoan(app, friend, shelf.copyId).expect(404)
    })

    it('право власника: чужий примірник — 404 і не змінюється; неавтентифікований — 401', async () => {
      await archive(stranger, shelf.copyId).expect(404)
      await archive(friend, shelf.copyId).expect(404)
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).archivedAt,
      ).toBeNull()

      await archive(owner, shelf.copyId).expect(200)
      await restore(stranger, shelf.copyId).expect(404)
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).archivedAt,
      ).not.toBeNull()

      await request(http())
        .post(url(`/me/library/${shelf.copyId}/archive`))
        .expect(401)
      await request(http())
        .post(url(`/me/library/${shelf.copyId}/restore`))
        .expect(401)
      await archive(owner, 'немає-такого').expect(404)
    })

    it('повторне архівування ідемпотентне й не змінює archivedAt', async () => {
      await archive(owner, shelf.copyId).expect(200)
      const first = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      await archive(owner, shelf.copyId).expect(200)

      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).archivedAt,
      ).toEqual(first.archivedAt)
    })
  })

  describe('A3: відкриті REQUESTED при архівуванні', () => {
    it('атомарно REJECTED зі сповіщеннями; чужі й завершені лоани не чіпаються', async () => {
      const other = await registerAccount(app, 'arch-other')

      await befriend(app, owner, other)

      const shelf = await createShelfCopy(app, owner)
      const firstLoanId = (
        (await requestLoan(app, friend, shelf.copyId).expect(201)).body as { loan: { id: string } }
      ).loan.id
      const secondLoanId = (
        (await requestLoan(app, other, shelf.copyId).expect(201)).body as { loan: { id: string } }
      ).loan.id

      const notificationsBefore = await prisma.notification.count({
        where: { type: 'LOAN_REJECTED' },
      })

      await archive(owner, shelf.copyId).expect(200)

      expect(await loanStatuses(shelf.copyId)).toEqual(['REJECTED', 'REJECTED'])

      const rejected = await prisma.notification.findMany({
        where: { type: 'LOAN_REJECTED', userId: { in: [friend.id, other.id] } },
      })

      expect(await prisma.notification.count({ where: { type: 'LOAN_REJECTED' } })).toBe(
        notificationsBefore + 2,
      )
      expect(rejected.map((notification) => notification.userId).sort()).toEqual(
        [friend.id, other.id].sort(),
      )
      expect(rejected.map((notification) => notification.payload)).toEqual(
        expect.arrayContaining([
          { loanId: firstLoanId, copyId: shelf.copyId, actorId: owner.id },
          { loanId: secondLoanId, copyId: shelf.copyId, actorId: owner.id },
        ]),
      )
      expect(
        (await prisma.loan.findUniqueOrThrow({ where: { id: firstLoanId } })).respondedAt,
      ).not.toBeNull()
    })
  })

  describe('A4: restore', () => {
    it('повертає примірник до звичайних вибірок, факти позик не змінюються', async () => {
      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, friend, shelf.copyId)

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      await archive(owner, shelf.copyId).expect(200)
      expect(await ownLibraryCopyIds(owner)).not.toContain(shelf.copyId)

      const restored = await restore(owner, shelf.copyId).expect(200)

      expect(copyResponseSchema.parse(restored.body).copy.id).toBe(shelf.copyId)
      expect(await ownLibraryCopyIds(owner)).toContain(shelf.copyId)
      expect(await ownLibraryCopyIds(owner, '?archived=true')).not.toContain(shelf.copyId)
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)

      const holders = await request(http())
        .get(url(`/works/${shelf.workId}/holders?availability=AVAILABLE`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(workHoldersResponseSchema.parse(holders.body).groups).toHaveLength(1)

      // Знову можна просити, а повторний restore — no-op.
      await restore(owner, shelf.copyId).expect(200)
      await requestLoan(app, friend, shelf.copyId).expect(201)
    })

    it('відхилені при архівуванні запити не оживають при restore', async () => {
      const shelf = await createShelfCopy(app, owner)

      await requestLoan(app, friend, shelf.copyId).expect(201)
      await archive(owner, shelf.copyId).expect(200)
      await restore(owner, shelf.copyId).expect(200)

      expect(await loanStatuses(shelf.copyId)).toEqual(['REJECTED'])
    })
  })

  describe('DEL1–DEL2: видалення лише без жодного Loan', () => {
    it('DEL1: примірник без позик видаляється (204), навіть коли він у ?archived', async () => {
      const shelf = await createShelfCopy(app, owner)

      await archive(owner, shelf.copyId).expect(200)
      await remove(owner, shelf.copyId).expect(204)

      expect(await prisma.copy.findUnique({ where: { id: shelf.copyId } })).toBeNull()
    })

    it.each([
      'REQUESTED',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'HANDED_OVER',
      'RETURNED',
      'LOST',
      'PENDING_CONFIRMATION',
      'DECLINED',
    ] as const)('DEL2: Loan у %s → 409 COPY_HAS_LOAN_HISTORY, Loan і Copy цілі', async (status) => {
      const shelf = await createShelfCopy(app, owner)
      const loan = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: friend.id,
          status,
          ...(status === 'HANDED_OVER' || status === 'RETURNED' || status === 'LOST'
            ? { handedAt: new Date('2026-01-10T00:00:00.000Z') }
            : {}),
        },
      })
      const snapshot = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
      const response = await remove(owner, shelf.copyId).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.COPY_HAS_LOAN_HISTORY)
      expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(1)
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(snapshot)
    })

    it('чужий примірник — 404 і не видаляється', async () => {
      const shelf = await createShelfCopy(app, owner)

      await remove(stranger, shelf.copyId).expect(404)
      await remove(friend, shelf.copyId).expect(404)

      expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(1)
    })
  })

  describe('DEL3: гонка delete ∥ новий запит на позичання', () => {
    it('обидва впираються в лок Copy: жодного 500, узгоджений результат', async () => {
      const shelf = await createShelfCopy(app, owner)
      const holder = new Client({ connectionString: testDatabaseUrl() })

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

        const deleting = beginRequest(remove(owner, shelf.copyId))
        const requesting = beginRequest(requestLoan(app, friend, shelf.copyId))

        await waitForBlockedBackend(prisma, { expectedCount: 2 })
        await holder.query('COMMIT')

        const [deleted, requested] = await Promise.all([deleting, requesting])
        const outcome = `${String(deleted.status)}/${String(requested.status)}`

        // Або видалення виграло (запит бачить, що примірника вже немає), або запит виграв
        // (видалення бачить історію). Будь-що інше — 5xx чи «і те, і те» — помилка.
        expect(['204/404', '409/201']).toContain(outcome)

        if (outcome === '409/201') {
          expect(apiErrorSchema.parse(deleted.body).code).toBe(
            API_ERROR_CODES.COPY_HAS_LOAN_HISTORY,
          )
          expect(await loanStatuses(shelf.copyId)).toEqual(['REQUESTED'])
          expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(1)
        } else {
          expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(0)
          expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)
        }
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    })

    it('архівування ∥ новий запит: рівно один порядок, без висячих REQUESTED на архівному', async () => {
      const shelf = await createShelfCopy(app, owner)
      const holder = new Client({ connectionString: testDatabaseUrl() })

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

        const archiving = beginRequest(archive(owner, shelf.copyId))
        const requesting = beginRequest(requestLoan(app, friend, shelf.copyId))

        await waitForBlockedBackend(prisma, { expectedCount: 2 })
        await holder.query('COMMIT')

        const [archived, requested] = await Promise.all([archiving, requesting])

        expect(archived.status).toBe(200)
        expect([201, 404]).toContain(requested.status)

        const stored = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

        expect(stored.archivedAt).not.toBeNull()
        expect(
          await prisma.loan.count({ where: { copyId: shelf.copyId, status: 'REQUESTED' } }),
        ).toBe(0)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    })
  })
})
