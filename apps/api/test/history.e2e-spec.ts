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
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
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
