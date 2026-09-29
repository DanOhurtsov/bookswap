import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  NOTIFICATION_PREFERENCE_LIMITS,
  NOTIFICATION_TYPE,
  PREFERENCE_CHANNEL,
  apiErrorSchema,
  defaultPreferenceEnabled,
  isGuestResponseNotificationType,
  notificationListResponseSchema,
  notificationPreferencesResponseSchema,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { registerAccount, url, type Account } from './loan.helpers'
import { NotificationsService } from '../src/notifications/notifications.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { NotificationPreference } from '@bookswap/shared'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * §7.6 і §8: матриця «тип події × канал».
 *
 * Найважливіше тут — не CRUD, а зв'язок налаштувань із доставкою: перемикач, який
 * зберігається, але ні на що не впливає, гірший за його відсутність.
 */
describe('Налаштування сповіщень (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let notifications: NotificationsService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    notifications = app.get(NotificationsService)
  })

  afterAll(async () => {
    await app.close()
  })

  const codeOf = (body: unknown): string => apiErrorSchema.parse(body).code

  function get(account: Account): request.Test {
    return request(app.getHttpServer())
      .get(url('/me/notification-preferences'))
      .set('Cookie', account.cookie)
  }

  function put(account: Account, preferences: unknown): request.Test {
    return request(app.getHttpServer())
      .put(url('/me/notification-preferences'))
      .set('Cookie', account.cookie)
      .send({ preferences })
  }

  async function matrixOf(account: Account): Promise<NotificationPreference[]> {
    const response = await get(account).expect(200)

    return notificationPreferencesResponseSchema.parse(response.body).preferences
  }

  const cell = (
    matrix: NotificationPreference[],
    type: string,
    channel: string,
  ): boolean | undefined =>
    matrix.find((row) => row.type === type && row.channel === channel)?.enabled

  describe('§8: GET /me/notification-preferences', () => {
    it('віддає всю матрицю, а не лише збережені клітинки', async () => {
      const account = await registerAccount(app, 'prefs-full')
      const matrix = await matrixOf(account)

      expect(matrix).toHaveLength(NOTIFICATION_PREFERENCE_LIMITS.matrixSize)
      expect(matrix).toHaveLength(NOTIFICATION_TYPE.length * PREFERENCE_CHANNEL.length)
    })

    /**
     * Дефолти рахує та сама функція зі `shared`, якою користується фронт. Якби
     * сервер відповідав інакше, сторінка показувала б один стан, а диспетчер
     * робив би інший — і помітили б це лише за скаргою «мені не прийшов лист».
     */
    it('незаймані клітинки збігаються з політикою §7.6', async () => {
      const account = await registerAccount(app, 'prefs-defaults')
      const matrix = await matrixOf(account)

      for (const row of matrix) {
        expect(row.enabled).toBe(
          defaultPreferenceEnabled(row.type, row.channel, { telegramLinked: false }),
        )
      }

      // Критичне для флоу — в EMAIL; підтвердження доконаного факту — ні.
      expect(cell(matrix, 'LOAN_REQUESTED', 'EMAIL')).toBe(true)
      expect(cell(matrix, 'LOAN_RETURNED', 'EMAIL')).toBe(false)
      // Telegram не підключений — уся колонка вимкнена.
      expect(matrix.filter((row) => row.channel === 'TELEGRAM').every((row) => !row.enabled)).toBe(
        true,
      )
    })

    it('віддає стан каналів (§7.4)', async () => {
      const account = await registerAccount(app, 'prefs-channels')
      const response = await get(account).expect(200)
      const { channels } = notificationPreferencesResponseSchema.parse(response.body)

      expect(channels.email.address).toContain('@example.com')
      expect(channels.email.verified).toBe(false)
      expect(channels.telegram.connected).toBe(false)

      await prisma.user.update({
        where: { id: account.id },
        data: { telegramChatId: `prefs-chat-${account.id}` },
      })

      const after = notificationPreferencesResponseSchema.parse(
        (await get(account).expect(200)).body,
      )

      expect(after.channels.telegram.connected).toBe(true)
      // §7.6: «після підключення Telegram — усе в TELEGRAM» — крім in-app-only типів (10i.3, відповіді гостя).
      expect(
        after.preferences
          .filter((row) => row.channel === 'TELEGRAM' && !isGuestResponseNotificationType(row.type))
          .every((row) => row.enabled),
      ).toBe(true)
      expect(cell(after.preferences, 'GUEST_LOAN_RECEIVED', 'TELEGRAM')).toBe(false)
      expect(cell(after.preferences, 'GUEST_LOAN_DENIED', 'TELEGRAM')).toBe(false)
      // …«з можливістю вимкнути email», а не з автоматичним вимкненням.
      expect(cell(after.preferences, 'LOAN_REQUESTED', 'EMAIL')).toBe(true)
    })

    it('без сесії — 401', async () => {
      await request(app.getHttpServer()).get(url('/me/notification-preferences')).expect(401)
    })
  })

  describe('§8: PUT /me/notification-preferences', () => {
    it('зберігає клітинку й віддає підсумкову матрицю', async () => {
      const account = await registerAccount(app, 'prefs-save')
      const response = await put(account, [
        { type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false },
      ]).expect(200)

      const { preferences } = notificationPreferencesResponseSchema.parse(response.body)

      expect(cell(preferences, 'LOAN_REQUESTED', 'EMAIL')).toBe(false)
      expect(cell(await matrixOf(account), 'LOAN_REQUESTED', 'EMAIL')).toBe(false)
    })

    /**
     * `PUT`, але не «замінити все на надіслане»: інакше клієнт мусив би надсилати
     * матрицю цілком заради одного перемикача, а старіший клієнт мовчки скидав би
     * кожен новий тип події до дефолту.
     */
    it('не скидає клітинки, яких немає в тілі', async () => {
      const account = await registerAccount(app, 'prefs-partial')

      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }]).expect(200)
      await put(account, [{ type: 'LOAN_APPROVED', channel: 'EMAIL', enabled: false }]).expect(200)

      const matrix = await matrixOf(account)

      expect(cell(matrix, 'LOAN_REQUESTED', 'EMAIL')).toBe(false)
      expect(cell(matrix, 'LOAN_APPROVED', 'EMAIL')).toBe(false)
    })

    it('повторний однаковий запит нічого не змінює', async () => {
      const account = await registerAccount(app, 'prefs-idempotent')
      const body = [{ type: 'FRIEND_REQUESTED', channel: 'EMAIL', enabled: false }]

      await put(account, body).expect(200)
      await put(account, body).expect(200)

      expect(
        await prisma.notificationPreference.count({
          where: { userId: account.id, type: 'FRIEND_REQUESTED', channel: 'EMAIL' },
        }),
      ).toBe(1)
    })

    it('вмикання назад повертає дефолтну поведінку', async () => {
      const account = await registerAccount(app, 'prefs-back')

      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }]).expect(200)
      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: true }]).expect(200)

      expect(cell(await matrixOf(account), 'LOAN_REQUESTED', 'EMAIL')).toBe(true)
    })

    /**
     * Увімкнути канал, у який фізично нема куди слати, — це тиха обіцянка, якої
     * система не виконає. Окремий код, щоб UI повів людину до кнопки
     * «Підключити Telegram», а не показав «збережено».
     */
    it('TELEGRAM без прив’язки — 409 з машиночитним кодом', async () => {
      const account = await registerAccount(app, 'prefs-tg')
      const response = await put(account, [
        { type: 'LOAN_REQUESTED', channel: 'TELEGRAM', enabled: true },
      ]).expect(409)

      expect(codeOf(response.body)).toBe(API_ERROR_CODES.TELEGRAM_NOT_LINKED)
      expect(await prisma.notificationPreference.count({ where: { userId: account.id } })).toBe(0)
    })

    it('вимкнути TELEGRAM без прив’язки можна — це нічого не обіцяє', async () => {
      const account = await registerAccount(app, 'prefs-tg-off')

      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'TELEGRAM', enabled: false }]).expect(
        200,
      )
    })

    it.each([
      {
        name: 'невідомий канал',
        body: [{ type: 'LOAN_REQUESTED', channel: 'SMS', enabled: true }],
      },
      { name: 'невідомий тип', body: [{ type: 'LOAN_EATEN', channel: 'EMAIL', enabled: true }] },
      { name: 'порожній список', body: [] },
      {
        name: 'дубльована клітинка',
        body: [
          { type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: true },
          { type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false },
        ],
      },
      {
        name: 'enabled рядком',
        body: [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: 'no' }],
      },
    ])('відхиляє: $name', async ({ body }) => {
      const account = await registerAccount(app, 'prefs-invalid')
      const response = await put(account, body).expect(400)

      expect(codeOf(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('без сесії — 401', async () => {
      await request(app.getHttpServer())
        .put(url('/me/notification-preferences'))
        .send({ preferences: [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }] })
        .expect(401)
    })

    it('чужі налаштування не видно й не змінити', async () => {
      const marta = await registerAccount(app, 'prefs-marta')
      const oles = await registerAccount(app, 'prefs-oles')

      await put(marta, [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }]).expect(200)

      expect(cell(await matrixOf(oles), 'LOAN_REQUESTED', 'EMAIL')).toBe(true)
    })
  })

  describe('§7.6: IN_APP — повноправна клітинка', () => {
    /**
     * Спокуса оголосити in-app «завжди увімкненим» забирає в людини цілком
     * осмислений вибір: отримувати сповіщення лише в Telegram і не бачити
     * лічильника непрочитаних на сайті.
     */
    it('вимкнений IN_APP при увімкненому EMAIL прибирає подію зі списку', async () => {
      const account = await registerAccount(app, 'inapp-off')

      await prisma.user.update({ where: { id: account.id }, data: { emailVerified: true } })
      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'IN_APP', enabled: false }]).expect(
        200,
      )

      await notifications.create({
        userId: account.id,
        type: 'LOAN_REQUESTED',
        payload: { loanId: 'loan-inapp', copyId: 'copy-inapp' },
      })

      const notification = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: notification.id },
        select: { channel: true },
      })

      // Зовнішній канал лишився, in-app зник.
      expect(deliveries.map((row) => row.channel)).toEqual(['EMAIL'])

      // І центр сповіщень цієї події не показує — ні в списку, ні в лічильнику.
      const list = await request(app.getHttpServer())
        .get(url('/me/notifications'))
        .set('Cookie', account.cookie)
        .expect(200)
      const body = notificationListResponseSchema.parse(list.body)

      expect(body.notifications.map((item) => item.id)).not.toContain(notification.id)
      expect(body.unreadCount).toBe(0)

      // Позначити прочитаним теж не можна: для цієї людини події в застосунку немає.
      await request(app.getHttpServer())
        .patch(url(`/me/notifications/${notification.id}/read`))
        .set('Cookie', account.cookie)
        .expect(404)
    })

    /**
     * Перемикач діє на майбутні події, а не переписує минулі: інакше вимкнення
     * in-app мовчки стерло б історію, яку людина вже бачила.
     */
    it('зміна перемикача не чіпає вже створені події', async () => {
      const account = await registerAccount(app, 'inapp-history')

      await notifications.create({
        userId: account.id,
        type: 'LOAN_REQUESTED',
        payload: { loanId: 'loan-before', copyId: 'copy-before' },
      })

      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'IN_APP', enabled: false }]).expect(
        200,
      )

      const list = await request(app.getHttpServer())
        .get(url('/me/notifications'))
        .set('Cookie', account.cookie)
        .expect(200)

      // Стара подія лишилася видимою — її IN_APP-доставка вже існує.
      expect(notificationListResponseSchema.parse(list.body).notifications).toHaveLength(1)

      // А нова вже ні.
      await notifications.create({
        userId: account.id,
        type: 'LOAN_REQUESTED',
        payload: { loanId: 'loan-after', copyId: 'copy-after' },
      })

      const after = await request(app.getHttpServer())
        .get(url('/me/notifications'))
        .set('Cookie', account.cookie)
        .expect(200)

      expect(notificationListResponseSchema.parse(after.body).notifications).toHaveLength(1)
    })

    it('вимкнути можна всі три канали — подія лишиться лише в базі', async () => {
      const account = await registerAccount(app, 'inapp-all-off')

      await put(account, [
        { type: 'LOAN_RETURNED', channel: 'IN_APP', enabled: false },
        { type: 'LOAN_RETURNED', channel: 'EMAIL', enabled: false },
      ]).expect(200)

      await notifications.create({
        userId: account.id,
        type: 'LOAN_RETURNED',
        payload: { loanId: 'loan-silent', copyId: 'copy-silent' },
      })

      const notification = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(
        await prisma.notificationDelivery.count({ where: { notificationId: notification.id } }),
      ).toBe(0)
    })
  })

  describe('§6.1: непідтверджена адреса', () => {
    /**
     * Доки людина не довела, що читає цю скриньку, надсилати туди чужі імена й
     * назви книжок не можна. Налаштування при цьому зберігається — адресу
     * підтверджують тим самим листом, і забороняти вибір наперед було б колом.
     */
    it('EMAIL-доставок не буває, але перемикач зберігається', async () => {
      const account = await registerAccount(app, 'unverified-email')

      await put(account, [{ type: 'LOAN_RETURNED', channel: 'EMAIL', enabled: true }]).expect(200)
      await notifications.create({
        userId: account.id,
        type: 'LOAN_RETURNED',
        payload: { loanId: 'loan-unverified', copyId: 'copy-unverified' },
      })

      const first = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(
        (await prisma.notificationDelivery.findMany({ where: { notificationId: first.id } })).map(
          (row) => row.channel,
        ),
      ).toEqual(['IN_APP'])

      // Після підтвердження — той самий збережений вибір починає діяти.
      await prisma.user.update({ where: { id: account.id }, data: { emailVerified: true } })
      await notifications.create({
        userId: account.id,
        type: 'LOAN_RETURNED',
        payload: { loanId: 'loan-verified', copyId: 'copy-verified' },
      })

      const second = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(
        (await prisma.notificationDelivery.findMany({ where: { notificationId: second.id } }))
          .map((row) => row.channel)
          .sort(),
      ).toEqual(['EMAIL', 'IN_APP'])
    })

    it('контракт позначає непідтверджену пошту як недоступну', async () => {
      const account = await registerAccount(app, 'unverified-status')
      const response = await get(account).expect(200)
      const { channels } = notificationPreferencesResponseSchema.parse(response.body)

      expect(channels.email.verified).toBe(false)
      expect(channels.email.available).toBe(false)
      // Але канал на сервері налаштований — це різні речі.
      expect(channels.email.configured).toBe(true)
    })
  })

  describe('§7.3 + §7.6: налаштування керують доставками', () => {
    /**
     * Те, заради чого матриця існує. Перемикач, який зберігається, але не впливає
     * на створення `NotificationDelivery`, — це інтерфейс, що бреше.
     */
    it('вимкнений EMAIL прибирає рядок доставки, лишаючи IN_APP', async () => {
      const account = await registerAccount(app, 'prefs-effect')

      await put(account, [{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }]).expect(200)

      await notifications.create({
        userId: account.id,
        type: 'LOAN_REQUESTED',
        payload: { loanId: 'loan-prefs', copyId: 'copy-prefs' },
      })

      const notification = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: notification.id },
      })

      expect(deliveries.map((row) => row.channel)).toEqual(['IN_APP'])
    })

    it('увімкнений EMAIL для типу, де він вимкнений за замовчуванням, додає рядок', async () => {
      const account = await registerAccount(app, 'prefs-effect-on')

      // §6.1: без підтвердженої адреси EMAIL-доставок не буває взагалі, тож
      // перевірка самого перемикача вимагає спершу закрити це питання.
      await prisma.user.update({ where: { id: account.id }, data: { emailVerified: true } })

      // §7.6: `LOAN_RETURNED` не критичний для флоу, тож дефолт — вимкнено.
      await put(account, [{ type: 'LOAN_RETURNED', channel: 'EMAIL', enabled: true }]).expect(200)

      await notifications.create({
        userId: account.id,
        type: 'LOAN_RETURNED',
        payload: { loanId: 'loan-prefs2', copyId: 'copy-prefs2' },
      })

      const notification = await prisma.notification.findFirstOrThrow({
        where: { userId: account.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(
        (
          await prisma.notificationDelivery.findMany({
            where: { notificationId: notification.id },
          })
        )
          .map((row) => row.channel)
          .sort(),
      ).toEqual(['EMAIL', 'IN_APP'])
    })
  })
})
