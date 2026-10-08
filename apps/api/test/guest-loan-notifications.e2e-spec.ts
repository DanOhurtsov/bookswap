import './helpers/guest-loans-on'
import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import request from 'supertest'
import {
  GUEST_RESPONSE_NOTIFICATION_TYPE,
  externalBorrowerResponseSchema,
  guestLoanConfirmationResponseSchema,
  issueGuestConfirmationLinkResponseSchema,
  notificationListResponseSchema,
  notificationPreferencesResponseSchema,
  verifyGuestCodeResponseSchema,
  type GuestLoanConfirmation,
} from '@bookswap/shared'
import { createTestApp, uniqueEmail } from './auth.helpers'
import {
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { DevEmailSender } from '../src/email/dev-email-sender'
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from '../src/email/email-sender'
import { NotificationDispatcher } from '../src/notifications/notification-dispatcher.service'
import { NotificationPreferencesService } from '../src/notifications/notification-preferences.service'
import { renderNotification } from '../src/notifications/notification-renderer'
import { NotificationsService } from '../src/notifications/notifications.service'
import { PrismaService } from '../src/prisma/prisma.service'
import { TelegramConfig } from '../src/telegram/telegram.config'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10i.3: сповіщення власнику про відповіді гостя (`GUEST_LOAN_RECEIVED`,
 * `GUEST_LOAN_DENIED`). Політика каналів — рішення PO (forward-запис у плані): IN_APP змістовно; EMAIL
 * за звичайними правилами (підтверджена адреса, налаштування; увімкнений за замовчуванням), але лише
 * ЗАГАЛЬНИЙ лист; TELEGRAM недоступний ніколи.
 * Перевіряється: адресат, кількість (рівно одна Notification на належну відповідь), атомарність із
 * відповіддю, канали й — на рівні повідомлення, фактично переданого `EmailSender.send`, — відсутність
 * даних гостя в листі власнику. Лише синтетичні дані (D2).
 */
describe('Stage 10 (10i.3): сповіщення власнику про відповідь гостя (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let mail: DevEmailSender
  const http = (): App => app.getHttpServer()
  const GUEST_TYPES = [...GUEST_RESPONSE_NOTIFICATION_TYPE]

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    mail = app.get(DevEmailSender)
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const synthetic = (prefix: string): string =>
    uniqueEmail(prefix).replace(/@.*$/, '@guest.invalid')

  interface Ctx {
    owner: Account
    shelf: Shelf
    contactId: string
    confirmation: GuestLoanConfirmation
    alias: string
  }

  async function open(
    prefix: string,
    ownerAccount?: Account,
    beforeConfirm?: (shelf: Shelf) => Promise<void>,
  ): Promise<Ctx> {
    const owner = ownerAccount ?? (await registerAccount(app, prefix))
    const shelf = await createShelfCopy(app, owner)
    const alias = `Аліас ${prefix} ${String(Date.now())}`
    const contact = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', owner.cookie)
      .send({ alias, ownerInformed: true })
      .expect(201)
    const contactId = externalBorrowerResponseSchema.parse(contact.body).contact.id

    await beforeConfirm?.(shelf)

    const created = await request(http())
      .post(url('/guest-loan-confirmations'))
      .set('Cookie', owner.cookie)
      .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
      .expect(201)

    return {
      owner,
      shelf,
      contactId,
      alias,
      confirmation: guestLoanConfirmationResponseSchema.parse(created.body).confirmation,
    }
  }

  async function issueCopy(ctx: Ctx): Promise<string> {
    const response = await request(http())
      .post(url(`/guest-loan-confirmations/${ctx.confirmation.id}/link`))
      .set('Cookie', ctx.owner.cookie)
      .send({ delivery: 'COPY' })
      .expect(201)
    const link = issueGuestConfirmationLinkResponseSchema.parse(response.body).url
    const match = /#([A-Za-z0-9_%-]+)$/.exec(link ?? '')

    if (match?.[1] === undefined) throw new Error('У відповіді немає токена')

    return decodeURIComponent(match[1])
  }

  const pub = (path: string, body: object): request.Test =>
    request(http())
      .post(url(`/guest-loan-responses/${path}`))
      .send(body)

  interface Guest {
    token: string
    nickname: string
    email: string
  }

  const guestFor = (token: string): Guest => ({
    token,
    nickname: `Нікнейм-Гостя-${String(Date.now())}`,
    email: synthetic('gc-notif'),
  })

  async function proofOf(guest: Guest): Promise<string> {
    await pub('code', guest).expect(200)

    const code = /Код підтвердження: (\d{6})/.exec(mail.sealedTo(guest.email)?.body ?? '')?.[1]

    if (code === undefined) throw new Error('У листі немає коду')

    const response = await pub('verify', { ...guest, code }).expect(200)

    return verifyGuestCodeResponseSchema.parse(response.body).proof
  }

  const guestNotifications = (userId: string) =>
    prisma.notification.findMany({
      where: { userId, type: { in: GUEST_TYPES } },
      include: { deliveries: true },
    })

  const countGuestNotificationsFor = async (ctx: Ctx): Promise<number> =>
    (await guestNotifications(ctx.owner.id)).length

  describe('адресат, кількість і зміст', () => {
    it.each([
      ['RECEIVED', 'GUEST_LOAN_RECEIVED'],
      ['DENIED', 'GUEST_LOAN_DENIED'],
    ] as const)(
      '%s: рівно одне сповіщення власнику позики з id-only payload; непідтверджена пошта — лише IN_APP',
      async (answer, type) => {
        const bystander = await registerAccount(app, 'notif-bystander')
        const ctx = await open(`notif-${answer}`)
        const guest = guestFor(await issueCopy(ctx))
        const proof = await proofOf(guest)

        expect(await countGuestNotificationsFor(ctx)).toBe(0)

        await pub('answer', { ...guest, proof, answer }).expect(200)

        const rows = await guestNotifications(ctx.owner.id)

        expect(rows).toHaveLength(1)

        const [row] = rows

        expect(row?.type).toBe(type)
        expect(row?.userId).toBe(ctx.owner.id)
        expect(row?.readAt).toBeNull()
        // Лише ідентифікатори: ні нікнейма, ні email, ні alias.
        expect(row?.payload).toEqual({
          loanId: ctx.confirmation.loan.id,
          copyId: ctx.shelf.copyId,
          confirmationId: ctx.confirmation.id,
        })
        expect(row?.deliveries.map((delivery) => delivery.channel)).toEqual(['IN_APP'])

        // Стороння людина нічого не отримує; гість і контакт акаунтів не мають.
        expect(await guestNotifications(bystander.id)).toHaveLength(0)

        const list = notificationListResponseSchema.parse(
          (
            await request(http())
              .get(url('/me/notifications'))
              .set('Cookie', ctx.owner.cookie)
              .expect(200)
          ).body,
        )

        expect(list.notifications.filter((item) => item.type === type)).toHaveLength(1)
      },
    )

    it('RECEIVED відхиляє конкурентні REQUESTED: їхній автор має LOAN_REJECTED, а не сповіщення про гостя', async () => {
      const owner = await registerAccount(app, 'notif-rivals-owner')
      const rival = await registerAccount(app, 'notif-rivals-rival')

      await befriend(app, owner, rival)

      let rivalLoanId = ''
      const ctx = await open('notif-rivals', owner, async (shelf) => {
        const requested = await requestLoan(app, rival, shelf.copyId).expect(201)

        rivalLoanId = (requested.body as { loan: { id: string } }).loan.id
      })
      const guest = guestFor(await issueCopy(ctx))

      await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'RECEIVED' }).expect(200)

      expect(await guestNotifications(rival.id)).toHaveLength(0)
      expect(
        await prisma.notification.count({
          where: {
            userId: rival.id,
            type: 'LOAN_REJECTED',
            payload: { path: ['loanId'], equals: rivalLoanId },
          },
        }),
      ).toBe(1)
      expect(await countGuestNotificationsFor(ctx)).toBe(1)
    })

    it('«Не отримував» не чіпає REQUESTED, тож і їхні автори без сповіщень', async () => {
      const owner = await registerAccount(app, 'notif-denied-owner')
      const rival = await registerAccount(app, 'notif-denied-rival')

      await befriend(app, owner, rival)

      const ctx = await open('notif-denied-rivals', owner, async (shelf) => {
        await requestLoan(app, rival, shelf.copyId).expect(201)
      })
      const guest = guestFor(await issueCopy(ctx))
      const before = await prisma.notification.count({ where: { userId: rival.id } })

      await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'DENIED' }).expect(200)

      expect(await prisma.notification.count({ where: { userId: rival.id } })).toBe(before)
      expect(await countGuestNotificationsFor(ctx)).toBe(1)
    })
  })

  describe('рівно для належних відповідей', () => {
    it('нічого, доки немає прийнятої відповіді: видача посилання, код, хибний код, хибний доказ, дії власника', async () => {
      const ctx = await open('notif-none')
      const token = await issueCopy(ctx)
      const guest = guestFor(token)

      await pub('code', guest).expect(200)
      await pub('verify', { ...guest, code: '000000' }).expect(400)
      await pub('answer', { ...guest, proof: 'not-a-proof', answer: 'RECEIVED' }).expect(403)
      await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'RECEIVED' }).expect(200)
      expect(await countGuestNotificationsFor(ctx)).toBe(1)

      // Повторна відповідь тим самим (погашеним) посиланням — відмова, нового сповіщення немає.
      const replay = await pub('answer', { ...guest, proof: 'anything', answer: 'DENIED' })

      expect(replay.status).toBe(404)
      expect(await countGuestNotificationsFor(ctx)).toBe(1)
    })

    it('прострочене посилання: відповідь відхилена, сповіщення немає', async () => {
      const ctx = await open('notif-expired')
      const guest = guestFor(await issueCopy(ctx))
      const proof = await proofOf(guest)
      const expiresAt = new Date(Date.now() - 1000)

      await prisma.guestLoanConfirmation.update({
        where: { id: ctx.confirmation.id },
        data: {
          linkIssuedAt: new Date(expiresAt.getTime() - 7 * 24 * 60 * 60 * 1000),
          linkExpiresAt: expiresAt,
        },
      })

      await pub('answer', { ...guest, proof, answer: 'RECEIVED' }).expect(410)

      expect(await countGuestNotificationsFor(ctx)).toBe(0)
    })

    it('дії власника (скасування, запис зі слів) і повторна видача не створюють сповіщень про гостя', async () => {
      const cancelled = await open('notif-cancel')

      await issueCopy(cancelled)
      await issueCopy(cancelled)
      await request(http())
        .patch(url(`/guest-loan-confirmations/${cancelled.confirmation.id}`))
        .set('Cookie', cancelled.owner.cookie)
        .send({ action: 'cancel_handover', bookIsWithOwner: true })
        .expect(200)

      const recorded = await open('notif-record')

      await request(http())
        .patch(url(`/guest-loan-confirmations/${recorded.confirmation.id}`))
        .set('Cookie', recorded.owner.cookie)
        .send({ action: 'record_owner_statement' })
        .expect(200)

      expect(await countGuestNotificationsFor(cancelled)).toBe(0)
      expect(await countGuestNotificationsFor(recorded)).toBe(0)
    })

    it('ручний запис 10f.3 не створює сповіщень про гостя', async () => {
      const owner = await registerAccount(app, 'notif-manual')
      const shelf = await createShelfCopy(app, owner)
      const contact = await request(http())
        .post(url('/me/external-borrowers'))
        .set('Cookie', owner.cookie)
        .send({ alias: `Ручний ${String(Date.now())}`, ownerInformed: true })
        .expect(201)

      await request(http())
        .post(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .send({
          copyId: shelf.copyId,
          externalBorrowerId: externalBorrowerResponseSchema.parse(contact.body).contact.id,
          handedAt: '2026-01-01',
        })
        .expect(201)

      expect(await guestNotifications(owner.id)).toHaveLength(0)
    })
  })

  describe('атомарність із відповіддю', () => {
    it('збій запису сповіщення відкочує ВСЮ відповідь; після зняття збою та сама відповідь проходить один раз', async () => {
      const ctx = await open('notif-atomic')
      const ownerEmail = (
        await prisma.user.update({
          where: { id: ctx.owner.id },
          data: { emailVerified: true },
          select: { email: true },
        })
      ).email
      const sender = app.get<EmailSender>(EMAIL_SENDER)
      const sendSpy = jest.spyOn(sender, 'send')
      const mailToOwner = (): number =>
        sendSpy.mock.calls.filter(([message]) => message.to === ownerEmail).length
      const guest = guestFor(await issueCopy(ctx))
      const proof = await proofOf(guest)
      const notifications = app.get(NotificationsService)
      const original = notifications.create.bind(notifications)
      const spy = jest
        .spyOn(notifications, 'create')
        .mockImplementation((input, client) =>
          (GUEST_TYPES as readonly string[]).includes(input.type)
            ? Promise.reject(new Error('Симульований збій запису сповіщення'))
            : original(input, client),
        )

      await pub('answer', { ...guest, proof, answer: 'RECEIVED' }).expect(500)

      // Нічого не лишилось від часткового запису: позика, примірник, запит, аудит, контакт, сповіщення.
      const row = await prisma.guestLoanConfirmation.findUniqueOrThrow({
        where: { id: ctx.confirmation.id },
      })
      const contact = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: ctx.contactId },
      })

      expect(row.status).toBe('OPEN')
      expect(row.resolvedAt).toBeNull()
      expect(row.linkTokenHash).not.toBeNull()
      expect(
        (await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } })).status,
      ).toBe('PENDING_CONFIRMATION')
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })).status,
      ).toBe('RESERVED')
      expect(
        await prisma.loanEvent.count({
          where: {
            loanId: ctx.confirmation.loan.id,
            type: { in: ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] },
          },
        }),
      ).toBe(0)
      expect(contact.guestNickname).toBeNull()
      expect(contact.guestEmail).toBeNull()
      expect(await countGuestNotificationsFor(ctx)).toBe(0)
      expect(
        await prisma.notificationDelivery.count({
          where: { notification: { userId: ctx.owner.id, type: { in: GUEST_TYPES } } },
        }),
      ).toBe(0)

      await app.get(NotificationDispatcher).run()
      expect(mailToOwner()).toBe(0)

      spy.mockRestore()

      // Збій не спалив доказ: та сама відповідь після зняття збою проходить, сповіщення рівно одне.
      await pub('answer', { ...guest, proof, answer: 'RECEIVED' }).expect(200)
      await app.get(NotificationDispatcher).run()

      expect(await countGuestNotificationsFor(ctx)).toBe(1)
      expect(mailToOwner()).toBe(1)
    })
  })

  describe('канали: IN_APP + загальний EMAIL, без Telegram', () => {
    const channelsOf = (row: { deliveries: { channel: string }[] } | undefined): string[] =>
      (row?.deliveries ?? []).map((delivery) => delivery.channel).sort()

    /** Перехоплює те, що РЕАЛЬНО пішло в `EmailSender.send` (обгортка, не заміна: DevEmailSender працює). */
    const captureEmail = (): (() => EmailMessage[]) => {
      const sender = app.get<EmailSender>(EMAIL_SENDER)
      const original = sender.send.bind(sender)
      const spy = jest.spyOn(sender, 'send').mockImplementation((message) => original(message))

      return () => spy.mock.calls.map(([message]) => message)
    }

    const verifiedOwner = async (ctx: Ctx): Promise<string> => {
      const owner = await prisma.user.update({
        where: { id: ctx.owner.id },
        data: { emailVerified: true },
        select: { email: true },
      })

      return owner.email
    }

    it.each([
      ['RECEIVED', 'GUEST_LOAN_RECEIVED'],
      ['DENIED', 'GUEST_LOAN_DENIED'],
    ] as const)(
      '%s, підтверджена пошта: одна Notification, доставки IN_APP+EMAIL, у EmailSender іде лише загальний лист',
      async (answer, type) => {
        const ctx = await open(`notif-mail-${answer}`)
        const ownerEmail = await verifiedOwner(ctx)
        const guest = guestFor(await issueCopy(ctx))
        const proof = await proofOf(guest)
        const sent = captureEmail()
        const before = sent().length

        await pub('answer', { ...guest, proof, answer }).expect(200)

        const rows = await guestNotifications(ctx.owner.id)

        expect(rows).toHaveLength(1)
        expect(rows[0]?.type).toBe(type)
        expect(channelsOf(rows[0])).toEqual(['EMAIL', 'IN_APP'])

        // Ніщо не пішло в EmailSender у момент відповіді: лист — лише після коміту, з диспетчера.
        expect(sent()).toHaveLength(before)

        await app.get(NotificationDispatcher).run()

        const toOwner = sent().filter((message) => message.to === ownerEmail)

        expect(toOwner).toHaveLength(1)
        expect(toOwner[0]).toMatchObject({
          to: ownerEmail,
          subject: 'У вас нове повідомлення в BookSwap',
        })
        expect(toOwner[0]?.sealed).toBeUndefined()
        expect(toOwner[0]?.body).toBe(
          `У вас нове повідомлення в BookSwap\n\nЩоб його прочитати, увійдіть у BookSwap: ${app.get(ConfigService).getOrThrow<string>('WEB_ORIGIN')}/login`,
        )

        // Жодних даних гостя, книжки, результату чи ідентифікаторів у жодному фактично відправленому
        // листі власнику; листи гостю — лише запечатані й лише на його адресу.
        const forbidden = [
          guest.nickname,
          guest.email,
          guest.email.split('@')[0] ?? '',
          ctx.alias,
          guest.token,
          ctx.confirmation.id,
          ctx.confirmation.loan.id,
          ctx.shelf.copyId,
          answer,
          'отрим',
          'заперечує',
        ]
        const ownerHaystack = JSON.stringify(toOwner)

        for (const secret of forbidden) expect(ownerHaystack).not.toContain(secret)

        for (const message of sent().slice(before)) {
          expect(message.to).toBe(ownerEmail)
        }

        for (const message of sent()) {
          if (message.to === guest.email) expect(message.sealed).toBe(true)
        }

        expect(
          (await guestNotifications(ctx.owner.id))[0]?.deliveries.map(
            (delivery) => delivery.status,
          ),
        ).toEqual(expect.arrayContaining(['SENT']))
        expect(
          (await guestNotifications(ctx.owner.id))[0]?.deliveries.every(
            (delivery) => delivery.status === 'SENT',
          ),
        ).toBe(true)
      },
    )

    it('непідтверджена пошта або вимкнений EMAIL: лише IN_APP і жодного листа', async () => {
      const unverified = await open('notif-mail-unverified')
      const disabled = await open('notif-mail-disabled')
      const sent = captureEmail()

      await verifiedOwner(disabled)
      await request(http())
        .put(url('/me/notification-preferences'))
        .set('Cookie', disabled.owner.cookie)
        .send({
          preferences: GUEST_TYPES.map((type) => ({ type, channel: 'EMAIL', enabled: false })),
        })
        .expect(200)

      for (const ctx of [unverified, disabled]) {
        const guest = guestFor(await issueCopy(ctx))

        await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'RECEIVED' }).expect(
          200,
        )
        expect(channelsOf((await guestNotifications(ctx.owner.id))[0])).toEqual(['IN_APP'])
      }

      const ownerAddresses = (
        await prisma.user.findMany({
          where: { id: { in: [unverified.owner.id, disabled.owner.id] } },
          select: { email: true },
        })
      ).map((user) => user.email)

      await app.get(NotificationDispatcher).run()

      expect(sent().filter((message) => ownerAddresses.includes(message.to))).toHaveLength(0)
    })

    it('Telegram: навіть із прив’язаним чатом і явно ввімкненою клітинкою в базі доставки TELEGRAM немає', async () => {
      const ctx = await open('notif-channels')

      await prisma.user.update({
        where: { id: ctx.owner.id },
        data: { emailVerified: true, telegramChatId: `chat-${ctx.owner.id}` },
      })
      await prisma.notificationPreference.createMany({
        data: GUEST_TYPES.map((type) => ({
          userId: ctx.owner.id,
          type,
          channel: 'TELEGRAM' as const,
          enabled: true,
        })),
      })

      const guest = guestFor(await issueCopy(ctx))

      await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'DENIED' }).expect(200)

      const rows = await guestNotifications(ctx.owner.id)

      expect(rows).toHaveLength(1)
      expect(channelsOf(rows[0])).toEqual(['EMAIL', 'IN_APP'])

      await app.get(NotificationDispatcher).run()
    })

    it('контроль: для звичайного типу ті самі налаштування дають EMAIL і TELEGRAM (з налаштованим ботом)', async () => {
      const owner = await registerAccount(app, 'notif-control')

      await prisma.user.update({
        where: { id: owner.id },
        data: { emailVerified: true, telegramChatId: `chat-${owner.id}` },
      })

      const service = new NotificationPreferencesService(prisma, {
        configured: true,
      } as unknown as TelegramConfig)

      expect((await service.channelsFor(owner.id, 'LOAN_REQUESTED', prisma)).sort()).toEqual([
        'EMAIL',
        'IN_APP',
        'TELEGRAM',
      ])

      for (const type of GUEST_TYPES) {
        expect((await service.channelsFor(owner.id, type, prisma)).sort()).toEqual([
          'EMAIL',
          'IN_APP',
        ])
      }
    })

    it('PUT відхиляє ввімкнення TELEGRAM для відповідей гостя, дозволяє EMAIL; GET: EMAIL увімкнений, TELEGRAM ні', async () => {
      const owner = await registerAccount(app, 'notif-prefs')
      const matrixOf = async () =>
        notificationPreferencesResponseSchema.parse(
          (
            await request(http())
              .get(url('/me/notification-preferences'))
              .set('Cookie', owner.cookie)
              .expect(200)
          ).body,
        )

      const response = await request(http())
        .put(url('/me/notification-preferences'))
        .set('Cookie', owner.cookie)
        .send({
          preferences: [{ type: 'GUEST_LOAN_RECEIVED', channel: 'TELEGRAM', enabled: true }],
        })

      expect(response.status).toBe(400)
      expect((response.body as { code: string }).code).toBe('VALIDATION_ERROR')
      expect(
        await prisma.notificationPreference.count({
          where: { userId: owner.id, type: { in: GUEST_TYPES } },
        }),
      ).toBe(0)

      for (const type of GUEST_TYPES) {
        const cells = (await matrixOf()).preferences.filter((cell) => cell.type === type)

        expect(cells.find((cell) => cell.channel === 'IN_APP')?.enabled).toBe(true)
        expect(cells.find((cell) => cell.channel === 'EMAIL')?.enabled).toBe(true)
        expect(cells.find((cell) => cell.channel === 'TELEGRAM')?.enabled).toBe(false)
      }

      await request(http())
        .put(url('/me/notification-preferences'))
        .set('Cookie', owner.cookie)
        .send({ preferences: [{ type: 'GUEST_LOAN_DENIED', channel: 'EMAIL', enabled: false }] })
        .expect(200)

      expect(
        (await matrixOf()).preferences.find(
          (cell) => cell.type === 'GUEST_LOAN_DENIED' && cell.channel === 'EMAIL',
        )?.enabled,
      ).toBe(false)
    })
  })

  describe('приватність IN_APP', () => {
    it('нікнейм, email гостя й alias не потрапляють ні в payload, ні в API-відповідь, ні в текст рендера', async () => {
      const ctx = await open('notif-privacy')
      const guest = guestFor(await issueCopy(ctx))

      await pub('answer', { ...guest, proof: await proofOf(guest), answer: 'DENIED' }).expect(200)

      const rows = await guestNotifications(ctx.owner.id)
      const list = await request(http())
        .get(url('/me/notifications'))
        .set('Cookie', ctx.owner.cookie)
        .expect(200)
      const rendered = renderNotification({
        type: 'GUEST_LOAN_DENIED',
        payload: rows[0]?.payload as Record<string, string>,
        actorName: null,
        bookTitle: 'Книжка',
        webOrigin: 'https://bookswap.example',
      })
      const haystack = JSON.stringify([rows.map((row) => row.payload), list.body, rendered])

      for (const secret of [guest.nickname, guest.email, guest.email.split('@')[0], ctx.alias]) {
        expect(haystack).not.toContain(secret)
      }

      expect(rendered.body).toContain(`/loans/guest?confirmationId=${ctx.confirmation.id}`)
      expect(rendered.actions).toEqual([])
    })
  })
})
