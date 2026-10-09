import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  friendRequestsResponseSchema,
  loanResponseSchema,
  notificationListResponseSchema,
  notificationResponseSchema,
  readAllResponseSchema,
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
} from './loan.helpers'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * §8, блок «Сповіщення» — in-app читання.
 *
 * Заразом це єдине місце, де перевіряється, що переходи §5.1 справді пишуть
 * сповіщення саме тим людям і саме тих типів, які перелічує §7.5.
 */
describe('Сповіщення (e2e)', () => {
  let app: INestApplication<App>

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  const codeOf = (body: unknown): string => apiErrorSchema.parse(body).code

  function list(account: Account, query = ''): request.Test {
    return request(app.getHttpServer())
      .get(url(`/me/notifications${query}`))
      .set('Cookie', account.cookie)
  }

  /** Сповіщення, що стосуються конкретного лоану, — е2е-файли ділять одну базу. */
  async function forLoan(account: Account, loanId: string) {
    const response = await list(account).expect(200)

    return notificationListResponseSchema
      .parse(response.body)
      .notifications.filter((notification) => notification.payload.loanId === loanId)
  }

  describe('переходи §5.1 пишуть сповіщення §7.5', () => {
    it('запит сповіщає власника, апрув — позичальника', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
      const loanId = loanResponseSchema.parse(created.body).loan.id

      const ownerInbox = await forLoan(owner, loanId)

      expect(ownerInbox).toHaveLength(1)
      expect(ownerInbox[0]?.type).toBe('LOAN_REQUESTED')
      // §4.8: payload — самі ідентифікатори.
      expect(ownerInbox[0]?.payload).toEqual({
        loanId,
        copyId: shelf.copyId,
        actorId: borrower.id,
      })

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)

      const borrowerInbox = await forLoan(borrower, loanId)

      expect(borrowerInbox.map((notification) => notification.type)).toEqual(['LOAN_APPROVED'])
    })

    it('передача сповіщає власника, повернення — позичальника', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

      expect((await forLoan(owner, loanId)).map((item) => item.type)).toEqual([
        'LOAN_HANDED_OVER',
        'LOAN_REQUESTED',
      ])

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      expect((await forLoan(borrower, loanId)).map((item) => item.type)).toEqual([
        'LOAN_RETURNED',
        'LOAN_APPROVED',
      ])
    })

    it('скасування домовленості дає LOAN_CANCELLED другій стороні', async () => {
      // Саме заради цього рядка §5.1 до enum'а §4.8 додано окремий тип: «вам
      // відмовили» і «домовленість скасовано» — різні події.
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
      const loanId = loanResponseSchema.parse(created.body).loan.id

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
      await actOnLoan(app, borrower, loanId, { action: 'cancel' }).expect(200)

      // Скасував позичальник — отже, сповіщають власника.
      expect((await forLoan(owner, loanId)).map((item) => item.type)).toEqual([
        'LOAN_CANCELLED',
        'LOAN_REQUESTED',
      ])
    })

    it('скасування ЗАПИТУ і списання сповіщень не породжують', async () => {
      // §5.1 у цих рядках має порожню клітинку побічних ефектів, і §7.5 їх не
      // перелічує. Тест стежить, щоб їх не додали «для симетрії».
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const cancelShelf = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, cancelShelf.copyId).expect(201)
      const cancelledLoan = loanResponseSchema.parse(created.body).loan.id

      await actOnLoan(app, borrower, cancelledLoan, { action: 'cancel' }).expect(200)

      // У власника лишається тільки сам запит — жодного «він передумав».
      expect((await forLoan(owner, cancelledLoan)).map((item) => item.type)).toEqual([
        'LOAN_REQUESTED',
      ])

      const lostShelf = await createShelfCopy(app, owner)
      const lostLoan = await handedOverLoan(app, owner, borrower, lostShelf.copyId)

      await actOnLoan(app, owner, lostLoan, { action: 'mark_lost' }).expect(200)

      expect((await forLoan(borrower, lostLoan)).map((item) => item.type)).toEqual([
        'LOAN_APPROVED',
      ])
    })
  })

  describe('GET /me/notifications', () => {
    it('віддає лише свої, найновіші першими, з лічильником непрочитаних', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')
      const stranger = await registerAccount(app, 'notif-stranger')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
      const loanId = loanResponseSchema.parse(created.body).loan.id

      const response = await list(owner).expect(200)
      const inbox = notificationListResponseSchema.parse(response.body)

      expect(inbox.unreadCount).toBeGreaterThanOrEqual(1)
      expect(inbox.notifications[0]?.payload.loanId).toBe(loanId)

      const outsider = await list(stranger).expect(200)

      expect(notificationListResponseSchema.parse(outsider.body).notifications).toHaveLength(0)
      expect(outsider.text).not.toContain(loanId)
    })

    it('?unread=true фільтрує список, але не лічильник', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)

      await requestLoan(app, borrower, shelf.copyId).expect(201)

      const before = notificationListResponseSchema.parse((await list(owner).expect(200)).body)
      const [first] = before.notifications

      if (first === undefined) throw new Error('Недосяжно: сповіщення щойно створено')

      await request(app.getHttpServer())
        .patch(url(`/me/notifications/${first.id}/read`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const unread = notificationListResponseSchema.parse(
        (await list(owner, '?unread=true').expect(200)).body,
      )

      expect(unread.notifications.map((item) => item.id)).not.toContain(first.id)
      // Лічильник у навігації не залежить від того, яку вкладку відкрито.
      expect(unread.unreadCount).toBe(before.unreadCount - 1)
    })

    it('невідоме значення unread — 400, а не тихий фолбек', async () => {
      const account = await registerAccount(app, 'notif-user')

      await list(account, '?unread=maybe').expect(400)
      await list(account, '?unread=1').expect(400)
    })
  })

  describe('PATCH /me/notifications/:id/read', () => {
    async function firstNotification(account: Account): Promise<string> {
      const response = await list(account).expect(200)
      const [first] = notificationListResponseSchema.parse(response.body).notifications

      if (first === undefined) throw new Error('Недосяжно: сповіщення щойно створено')

      return first.id
    }

    async function inbox(): Promise<{ owner: Account; notificationId: string }> {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)

      await requestLoan(app, borrower, shelf.copyId).expect(201)

      return { owner, notificationId: await firstNotification(owner) }
    }

    it('позначає прочитаним і віддає оновлене сповіщення', async () => {
      const { owner, notificationId } = await inbox()

      const response = await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notificationId}/read`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(notificationResponseSchema.parse(response.body).notification.readAt).not.toBeNull()
    })

    it('повторне читання успішне й не рухає readAt', async () => {
      // `updateMany` з умовою `readAt: null` дає count = 0 і на вже прочитаному, і
      // на чужому, і на неіснуючому. Клієнту ці випадки різні: дві вкладки не
      // мусять давати помилку.
      const { owner, notificationId } = await inbox()

      const first = await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notificationId}/read`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const second = await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notificationId}/read`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(notificationResponseSchema.parse(second.body).notification.readAt).toBe(
        notificationResponseSchema.parse(first.body).notification.readAt,
      )
    })

    it('чуже й неіснуюче — однаково 404', async () => {
      const { notificationId } = await inbox()
      const stranger = await registerAccount(app, 'notif-stranger')

      const foreign = await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notificationId}/read`))
        .set('Cookie', stranger.cookie)
        .expect(404)

      expect(codeOf(foreign.body)).toBe(API_ERROR_CODES.NOT_FOUND)

      const missing = await request(app.getHttpServer())
        .patch(url('/me/notifications/notification-not-there/read'))
        .set('Cookie', stranger.cookie)
        .expect(404)

      expect(codeOf(missing.body)).toBe(API_ERROR_CODES.NOT_FOUND)
    })

    it('чуже сповіщення не стає прочитаним від спроби', async () => {
      const { owner, notificationId } = await inbox()
      const stranger = await registerAccount(app, 'notif-stranger')

      await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notificationId}/read`))
        .set('Cookie', stranger.cookie)
        .expect(404)

      const response = await list(owner, '?unread=true').expect(200)

      expect(
        notificationListResponseSchema.parse(response.body).notifications.map((item) => item.id),
      ).toContain(notificationId)
    })
  })

  describe('POST /me/notifications/read-all', () => {
    it('гасить усе непрочитане й другим разом віддає 0', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const first = await createShelfCopy(app, owner)
      const second = await createShelfCopy(app, owner)

      await requestLoan(app, borrower, first.copyId).expect(201)
      await requestLoan(app, borrower, second.copyId).expect(201)

      // Рахуємо саме непрочитані, а не «два запити»: у власника є ще
      // `FRIEND_ACCEPTED` від самого знайомства (§7.5), і константа тут
      // перетворила б тест на перелік усіх подій, які колись з'являться.
      const before = notificationListResponseSchema.parse((await list(owner).expect(200)).body)

      expect(before.unreadCount).toBeGreaterThanOrEqual(2)

      const readAll = await request(app.getHttpServer())
        .post(url('/me/notifications/read-all'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(readAllResponseSchema.parse(readAll.body).updated).toBe(before.unreadCount)

      const after = notificationListResponseSchema.parse((await list(owner).expect(200)).body)

      expect(after.unreadCount).toBe(0)

      const again = await request(app.getHttpServer())
        .post(url('/me/notifications/read-all'))
        .set('Cookie', owner.cookie)
        .expect(200)

      // Нуль — це правда, а не помилка: гасити вже нічого.
      expect(readAllResponseSchema.parse(again.body).updated).toBe(0)
    })

    it('зберігає історію й не відповідає на запит у друзі замість людини', async () => {
      const sender = await registerAccount(app, 'notif-sender')
      const recipient = await registerAccount(app, 'notif-recipient')

      await request(app.getHttpServer())
        .post(url('/friends/requests'))
        .set('Cookie', sender.cookie)
        .send({ userId: recipient.id })
        .expect(201)

      const before = notificationListResponseSchema.parse((await list(recipient).expect(200)).body)

      expect(before.notifications.map((notification) => notification.type)).toContain(
        'FRIEND_REQUESTED',
      )

      await request(app.getHttpServer())
        .post(url('/me/notifications/read-all'))
        .set('Cookie', recipient.cookie)
        .expect(200)

      const after = notificationListResponseSchema.parse((await list(recipient).expect(200)).body)

      // «Очистити» — це позначити, а не видалити: «усі» лишаються тими самими подіями.
      expect(after.notifications.map((notification) => notification.id)).toEqual(
        before.notifications.map((notification) => notification.id),
      )
      expect(after.notifications.every((notification) => notification.readAt !== null)).toBe(true)

      const requests = await request(app.getHttpServer())
        .get(url('/friends/requests'))
        .set('Cookie', recipient.cookie)
        .expect(200)

      // Прочитаний запит лишається активним: відповісти на нього людина ще може (FRND-09).
      expect(
        friendRequestsResponseSchema.parse(requests.body).incoming.map((item) => item.user.id),
      ).toEqual([sender.id])
    })

    it('не чіпає чужих сповіщень', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const borrower = await registerAccount(app, 'notif-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
      const loanId = loanResponseSchema.parse(created.body).loan.id

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)

      await request(app.getHttpServer())
        .post(url('/me/notifications/read-all'))
        .set('Cookie', owner.cookie)
        .expect(200)

      const borrowerInbox = notificationListResponseSchema.parse(
        (await list(borrower).expect(200)).body,
      )

      expect(borrowerInbox.unreadCount).toBeGreaterThanOrEqual(1)
    })
  })
})
