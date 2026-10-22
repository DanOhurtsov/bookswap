import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  copyHistoryResponseSchema,
  myHistoryResponseSchema,
  workHistoryResponseSchema,
  type MyHistoryEntry,
  type NamedHistoryEntry,
} from '@bookswap/shared'
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
  type Shelf,
} from './loan.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10 (10f.3): `MyHistoryEntry.entry` тепер union (`lent` може містити анонімний гостьовий
 * факт, §6.9 execution plan) — ці тести працюють лише з реєстрованими лоанами, де він завжди
 * іменований, тож звужуємо тип тут, а не послаблюємо перевірку.
 */
function named(item: MyHistoryEntry): NamedHistoryEntry {
  if (!item.entry.names) throw new Error('Очікувався іменований запис історії')

  return item.entry
}

/**
 * §6.6 «Історія» плюс рядок §9 «Історія примірника з іменами».
 *
 * Приватність перевіряється по **сирому** тілу відповіді: розібране zod'ом тіло
 * зрізало б зайве поле саме там, де його треба побачити. Той самий прийом, що вже
 * захищає нотатки власника у `friend-library.e2e-spec.ts`.
 */
describe('Історія (e2e)', () => {
  let app: INestApplication<App>

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  const codeOf = (body: unknown): string => apiErrorSchema.parse(body).code

  /** Завершений лоан: власник, позичальник і повернена книжка. */
  async function withHistory(): Promise<{
    owner: Account
    borrower: Account
    shelf: Shelf
    loanId: string
  }> {
    const owner = await registerAccount(app, 'hist-owner')
    const borrower = await registerAccount(app, 'hist-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

    await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

    return { owner, borrower, shelf, loanId }
  }

  function setHolderNames(account: Account, value: boolean): request.Test {
    return request(app.getHttpServer())
      .patch(url('/me'))
      .set('Cookie', account.cookie)
      .send({ showHolderNames: value })
  }

  function copyHistory(viewer: Account, copyId: string): request.Test {
    return request(app.getHttpServer())
      .get(url(`/copies/${copyId}/history`))
      .set('Cookie', viewer.cookie)
  }

  /** Усе, чим можна відновити особу або склеїти два зрізи історії. */
  const IDENTIFYING_KEYS = [
    'owner',
    'borrower',
    'ownerId',
    'borrowerId',
    'currentHolder',
    'currentHolderId',
    'holder',
    'loanId',
    'displayName',
    'avatarUrl',
    'email',
  ]

  describe('GET /copies/:id/history', () => {
    it('власник бачить повну історію з іменами — завжди', async () => {
      const { owner, borrower, shelf, loanId } = await withHistory()

      // Навіть із вимкненим власним прапорцем: він керує тим, що бачать ІНШІ.
      await setHolderNames(owner, false).expect(200)

      const response = await copyHistory(owner, shelf.copyId).expect(200)
      const history = copyHistoryResponseSchema.parse(response.body)
      const [entry] = history.entries

      expect(history.entries).toHaveLength(1)
      expect(entry?.names).toBe(true)

      if (entry?.names !== true) throw new Error('Недосяжно: власник бачить імена')

      expect(entry.loanId).toBe(loanId)
      expect(entry.borrower.id).toBe(borrower.id)
      expect(entry.status).toBe('RETURNED')
    })

    it('друг із showHolderNames = true бачить імена', async () => {
      const { owner, borrower, shelf } = await withHistory()

      await setHolderNames(owner, true).expect(200)

      const response = await copyHistory(borrower, shelf.copyId).expect(200)
      const [entry] = copyHistoryResponseSchema.parse(response.body).entries

      expect(entry?.names).toBe(true)
      expect(response.text).toContain(borrower.displayName)
    })

    it('друг із showHolderNames = false бачить статуси, і в СИРОМУ тілі немає жодного носія особи', async () => {
      const { owner, borrower, shelf } = await withHistory()

      await setHolderNames(owner, false).expect(200)

      const response = await copyHistory(borrower, shelf.copyId).expect(200)
      const history = copyHistoryResponseSchema.parse(response.body)
      const [entry] = history.entries

      // Факти лишаються — «у когось до 12 червня».
      expect(entry?.names).toBe(false)
      expect(entry?.status).toBe('RETURNED')
      expect(entry?.requestedAt).toBeDefined()

      const raw = response.text

      // Перевірка по сирому тілу: розібране схемою сховало б витік саме там, де
      // його треба побачити.
      for (const key of IDENTIFYING_KEYS) {
        expect(raw).not.toContain(`"${key}"`)
      }

      expect(raw).not.toContain(owner.id)
      expect(raw).not.toContain(borrower.id)
      expect(raw).not.toContain(owner.displayName)
      expect(raw).not.toContain(borrower.displayName)
    })

    it('сторонній не отримує історії навіть до цілком публічного примірника', async () => {
      // §9: видимість полиці й доступ до того, хто що в кого брав, — різні питання.
      // Публічними тут мусять бути ОБИДВІ осі — і бібліотека, і примірник:
      // видимість примірника = найсуворіше з двох, тож `PUBLIC`-примірник у
      // типовій `FRIENDS`-бібліотеці сторонньому просто не видно, і тест доводив
      // би не те (404 «не існує» замість 403 «історія недоступна»).
      const owner = await registerAccount(app, 'hist-owner')
      const stranger = await registerAccount(app, 'hist-stranger')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', owner.cookie)
        .send({ libraryVisibility: 'PUBLIC' })
        .expect(200)

      const shelf = await createShelfCopy(app, owner, 'PUBLIC')

      // Полиця сторонньому видна…
      await request(app.getHttpServer())
        .get(url(`/users/${owner.id}/library`))
        .set('Cookie', stranger.cookie)
        .expect(200)

      // …а історія — ні.
      const refused = await copyHistory(stranger, shelf.copyId).expect(403)

      expect(codeOf(refused.body)).toBe(API_ERROR_CODES.FORBIDDEN)
    })

    it('заблокований отримує 403 FRIENDSHIP_BLOCKED', async () => {
      const owner = await registerAccount(app, 'hist-owner')
      const blocked = await registerAccount(app, 'hist-blocked')

      await befriend(app, owner, blocked)

      const shelf = await createShelfCopy(app, owner, 'PUBLIC')

      await request(app.getHttpServer())
        .post(url(`/friends/${blocked.id}/block`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const refused = await copyHistory(blocked, shelf.copyId).expect(403)

      expect(codeOf(refused.body)).toBe(API_ERROR_CODES.FRIENDSHIP_BLOCKED)
    })

    it('невидимий примірник — 404, а не 403', async () => {
      const owner = await registerAccount(app, 'hist-owner')
      const friend = await registerAccount(app, 'hist-friend')

      await befriend(app, owner, friend)

      const shelf = await createShelfCopy(app, owner, 'PRIVATE')
      const refused = await copyHistory(friend, shelf.copyId).expect(404)

      expect(codeOf(refused.body)).toBe(API_ERROR_CODES.NOT_FOUND)
    })

    it('примірник у відповіді не несе власника — навіть для нього самого', async () => {
      // Поле, якого немає в схемі, не може витекти за жодного прапорця.
      const { owner, shelf } = await withHistory()
      const response = await copyHistory(owner, shelf.copyId).expect(200)
      const { copy } = copyHistoryResponseSchema.parse(response.body)

      expect(copy).not.toHaveProperty('ownerId')
      expect(copy).not.toHaveProperty('currentHolderId')
      expect(copy).not.toHaveProperty('owner')
      expect(copy.work.title).toContain('Полиця')
    })
  })

  describe('GET /works/:id/history', () => {
    it('показує лоани друзів і приховує чужі', async () => {
      const { owner, borrower, shelf } = await withHistory()
      const stranger = await registerAccount(app, 'hist-stranger')

      const asFriend = await request(app.getHttpServer())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', borrower.cookie)
        .expect(200)

      const friendHistory = workHistoryResponseSchema.parse(asFriend.body)

      expect(friendHistory.entries).toHaveLength(1)
      expect(friendHistory.entries[0]?.copyId).toBe(shelf.copyId)

      // Стороннього немає в §9-таблиці історії взагалі: твір він бачить, а хто
      // його читав — ні.
      const asStranger = await request(app.getHttpServer())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', stranger.cookie)
        .expect(200)

      expect(workHistoryResponseSchema.parse(asStranger.body).entries).toHaveLength(0)
      expect(asStranger.text).not.toContain(owner.id)
    })

    it('приховані імена не витікають і тут', async () => {
      const { owner, borrower, shelf } = await withHistory()

      await setHolderNames(owner, false).expect(200)

      const response = await request(app.getHttpServer())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', borrower.cookie)
        .expect(200)

      const history = workHistoryResponseSchema.parse(response.body)

      expect(history.entries[0]?.entry.names).toBe(false)
      expect(response.text).not.toContain(owner.displayName)
      expect(response.text).not.toContain(borrower.displayName)
    })

    it('власник бачить власні примірники з іменами', async () => {
      const { owner, shelf } = await withHistory()

      await setHolderNames(owner, false).expect(200)

      const response = await request(app.getHttpServer())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(workHistoryResponseSchema.parse(response.body).entries[0]?.entry.names).toBe(true)
    })
  })

  describe('GET /me/history', () => {
    it('розділяє «що я брав» і «що в мене брали»', async () => {
      const { owner, borrower, loanId } = await withHistory()

      const asBorrower = await request(app.getHttpServer())
        .get(url('/me/history'))
        .set('Cookie', borrower.cookie)
        .expect(200)

      const borrowerHistory = myHistoryResponseSchema.parse(asBorrower.body)

      expect(borrowerHistory.borrowed.map((item) => named(item).loanId)).toContain(loanId)
      expect(borrowerHistory.lent).toHaveLength(0)

      const asOwner = await request(app.getHttpServer())
        .get(url('/me/history'))
        .set('Cookie', owner.cookie)
        .expect(200)

      const ownerHistory = myHistoryResponseSchema.parse(asOwner.body)

      expect(ownerHistory.lent.map((item) => named(item).loanId)).toContain(loanId)
      expect(ownerHistory.borrowed).toHaveLength(0)
    })

    it('імена контрагентів видно завжди — §6.6 не про власні лоани', async () => {
      const { owner, borrower } = await withHistory()

      // Прапорець власника вимкнено, але позичальник — сторона цього лоану, а не
      // стороння людина, і без імені йому немає кому вертати книжку.
      await setHolderNames(owner, false).expect(200)

      const response = await request(app.getHttpServer())
        .get(url('/me/history'))
        .set('Cookie', borrower.cookie)
        .expect(200)

      const [item] = myHistoryResponseSchema.parse(response.body).borrowed

      expect(item?.entry.names).toBe(true)
      expect(item === undefined ? undefined : named(item).owner.id).toBe(owner.id)
    })

    it('BS-142: completedAt — лише з достовірного джерела, для обох сторін однаковий', async () => {
      const owner = await registerAccount(app, 'hist-done-own')
      const borrower = await registerAccount(app, 'hist-done-bor')

      await befriend(app, owner, borrower)

      const copyIds: Record<string, string> = {}
      const loanIds: Record<string, string> = {}
      const shelf = async (label: string): Promise<string> => {
        copyIds[label] = (await createShelfCopy(app, owner)).copyId

        return copyIds[label]
      }
      const requested = async (label: string): Promise<string> => {
        const created = await requestLoan(app, borrower, await shelf(label)).expect(201)

        loanIds[label] = (created.body as { loan: { id: string } }).loan.id

        return loanIds[label]
      }
      const recorded = async (label: string): Promise<string> => {
        const created = await request(app.getHttpServer())
          .post(url('/loans/recorded'))
          .set('Cookie', owner.cookie)
          .send({ copyId: await shelf(label), borrowerId: borrower.id, handedAt: '2026-01-05' })
          .expect(201)

        loanIds[label] = (created.body as { loan: { id: string } }).loan.id

        return loanIds[label]
      }

      loanIds.returned = await handedOverLoan(app, owner, borrower, await shelf('returned'))
      await actOnLoan(app, owner, loanIds.returned, { action: 'return' }).expect(200)
      await actOnLoan(app, owner, await requested('rejected'), { action: 'reject' }).expect(200)
      await actOnLoan(app, borrower, await requested('cancelled'), { action: 'cancel' }).expect(200)
      loanIds.lost = await handedOverLoan(app, owner, borrower, await shelf('lost'))
      await actOnLoan(app, owner, loanIds.lost, { action: 'mark_lost' }).expect(200)
      await actOnLoan(app, owner, await recorded('withdrawn'), {
        action: 'withdraw_record',
      }).expect(200)
      await actOnLoan(app, borrower, await recorded('declined'), {
        action: 'decline_record',
      }).expect(200)
      await recorded('pending')
      await requested('open')

      const prisma = app.get(PrismaService)
      const loan = (label: string) =>
        prisma.loan.findUniqueOrThrow({
          where: { id: loanIds[label] },
          select: { returnedAt: true, respondedAt: true },
        })
      const eventAt = async (
        label: string,
        type: 'LOAN_LOST' | 'RECORD_WITHDRAWN' | 'RECORD_DECLINED',
      ) =>
        (
          await prisma.loanEvent.findFirstOrThrow({
            where: { loanId: loanIds[label], type },
            select: { occurredAt: true },
          })
        ).occurredAt.toISOString()

      const expected: Record<string, string | null> = {
        returned: (await loan('returned')).returnedAt?.toISOString() ?? 'missing',
        rejected: (await loan('rejected')).respondedAt?.toISOString() ?? 'missing',
        lost: await eventAt('lost', 'LOAN_LOST'),
        withdrawn: await eventAt('withdrawn', 'RECORD_WITHDRAWN'),
        declined: await eventAt('declined', 'RECORD_DECLINED'),
        // The `cancel` of a request stamps nothing: its ending stays unknown, not guessed.
        cancelled: null,
        pending: null,
        open: null,
      }

      for (const [account, side] of [
        [owner, 'lent'],
        [borrower, 'borrowed'],
      ] as const) {
        const history = myHistoryResponseSchema.parse(
          (
            await request(app.getHttpServer())
              .get(url('/me/history'))
              .set('Cookie', account.cookie)
              .expect(200)
          ).body,
        )
        const byCopy = new Map(history[side].map((item) => [item.copy.id, item.completedAt]))

        expect(
          Object.fromEntries(
            Object.keys(expected).map((label) => [label, byCopy.get(copyIds[label] ?? '')]),
          ),
        ).toEqual(expected)
      }
    })

    it('BS-142: latestFactAt — остання достовірна дата; знахідка не є завершенням втрати', async () => {
      const owner = await registerAccount(app, 'hist-fact-own')
      const borrower = await registerAccount(app, 'hist-fact-bor')

      await befriend(app, owner, borrower)

      const prisma = app.get(PrismaService)
      const lostCopy = (await createShelfCopy(app, owner)).copyId
      const activeCopy = (await createShelfCopy(app, owner)).copyId
      const endedCopy = (await createShelfCopy(app, owner)).copyId

      // A loss from before Stage 10: handed over in January, no LOAN_LOST was ever written (REC5).
      const lost = await handedOverLoan(app, owner, borrower, lostCopy)

      await actOnLoan(app, owner, lost, { action: 'mark_lost' }).expect(200)
      await prisma.loanEvent.deleteMany({ where: { loanId: lost } })
      await prisma.loan.update({
        where: { id: lost },
        data: {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          requestedAt: new Date('2026-01-01T00:00:00Z'),
          respondedAt: new Date('2026-01-02T00:00:00Z'),
          handedAt: new Date('2026-01-03T00:00:00Z'),
        },
      })

      const active = await handedOverLoan(app, owner, borrower, activeCopy)

      await prisma.loan.update({
        where: { id: active },
        data: {
          createdAt: new Date('2026-02-01T00:00:00Z'),
          requestedAt: new Date('2026-02-01T00:00:00Z'),
          respondedAt: new Date('2026-02-02T00:00:00Z'),
          handedAt: new Date('2026-06-01T00:00:00Z'),
        },
      })
      // Found in September, recorded today: the actual date wins over the moment of writing.
      await actOnLoan(app, owner, lost, { action: 'recover', effectiveAt: '2026-09-01' }).expect(
        200,
      )

      // A loss with a known ending: a later recovery dates a fact, not the ending.
      const ended = await handedOverLoan(app, owner, borrower, endedCopy)

      await actOnLoan(app, owner, ended, { action: 'mark_lost' }).expect(200)
      await prisma.loan.update({
        where: { id: ended },
        data: {
          createdAt: new Date('2026-02-10T00:00:00Z'),
          requestedAt: new Date('2026-02-10T00:00:00Z'),
          respondedAt: new Date('2026-02-11T00:00:00Z'),
          handedAt: new Date('2026-02-12T00:00:00Z'),
        },
      })
      await prisma.loanEvent.updateMany({
        where: { loanId: ended, type: 'LOAN_LOST' },
        data: { effectiveAt: new Date('2026-03-01T00:00:00Z') },
      })
      await actOnLoan(app, owner, ended, { action: 'recover', effectiveAt: '2026-08-01' }).expect(
        200,
      )

      const recovery = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId: lost, type: 'RECOVERED' },
        select: { occurredAt: true },
      })

      expect(recovery.occurredAt.getTime()).toBeGreaterThan(Date.parse('2026-09-01T00:00:00Z'))

      for (const [account, side] of [
        [owner, 'lent'],
        [borrower, 'borrowed'],
      ] as const) {
        const body = (
          await request(app.getHttpServer())
            .get(url('/me/history'))
            .set('Cookie', account.cookie)
            .expect(200)
        ).body as Record<typeof side, Record<string, unknown>[]>
        const dates = new Map(
          myHistoryResponseSchema
            .parse(body)
            [side].map((item, index) => [item.copy.id, { ...item, raw: body[side][index] }]),
        )
        const of = (copyId: string) => {
          const item = dates.get(copyId)

          return { completedAt: item?.completedAt, latestFactAt: item?.raw?.latestFactAt }
        }

        expect(of(lostCopy)).toEqual({
          completedAt: null,
          latestFactAt: '2026-09-01T00:00:00.000Z',
        })
        expect(of(activeCopy)).toEqual({
          completedAt: null,
          latestFactAt: '2026-06-01T00:00:00.000Z',
        })
        expect(of(endedCopy)).toEqual({
          completedAt: '2026-03-01T00:00:00.000Z',
          latestFactAt: '2026-08-01T00:00:00.000Z',
        })

        // Only the derived date: no event, payload, actor or contact reaches the response.
        for (const item of body[side]) {
          expect(Object.keys(item).sort()).toEqual(['completedAt', 'copy', 'entry', 'latestFactAt'])
        }
        for (const key of [
          'events',
          'payload',
          'actorId',
          'effectiveAt',
          'occurredAt',
          'RECOVERED',
        ]) {
          expect(JSON.stringify(body)).not.toContain(`"${key}"`)
        }
      }

      // The status and the stored dates of the loan stay as they were.
      expect(
        await prisma.loan.findUniqueOrThrow({
          where: { id: lost },
          select: { status: true, handedAt: true, returnedAt: true },
        }),
      ).toEqual({ status: 'LOST', handedAt: new Date('2026-01-03T00:00:00Z'), returnedAt: null })
    })

    it('чужих лоанів у власній історії немає', async () => {
      const { loanId } = await withHistory()
      const stranger = await registerAccount(app, 'hist-stranger')

      const response = await request(app.getHttpServer())
        .get(url('/me/history'))
        .set('Cookie', stranger.cookie)
        .expect(200)

      const history = myHistoryResponseSchema.parse(response.body)

      expect(history.borrowed).toHaveLength(0)
      expect(history.lent).toHaveLength(0)
      expect(response.text).not.toContain(loanId)
    })
  })
})
