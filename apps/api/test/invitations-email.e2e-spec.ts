import 'reflect-metadata'
import { Logger, type INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_PREFIX,
  apiErrorSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { createHash, createHmac } from 'node:crypto'
import { hashToken } from '../src/auth/tokens'
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from '../src/email/email-sender'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

type Account = { id: string; cookie: string; email: string }

/** Підроблений адаптер: нічого нікуди не шле, лише запам'ятовує. */
class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = []
  failWith: Error | null = null

  send(message: EmailMessage): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith)

    this.sent.push(message)

    return Promise.resolve()
  }

  /** Лише листи-запрошення: реєстрація теж шле лист підтвердження. */
  get invites(): EmailMessage[] {
    return this.sent.filter((message) => message.idempotencyKey?.startsWith('invite:') === true)
  }

  to(address: string): EmailMessage[] {
    return this.invites.filter((message) => message.to === address)
  }
}

const HMAC_SECRET = 'invite-hmac-test-secret-0123456789abcdef'
process.env.INVITE_EMAIL_HMAC_SECRET = HMAC_SECRET

describe('Email invitations (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const fake = new FakeEmailSender()

  const url = (path: string): string => `${API_PREFIX}${path}`
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EMAIL_SENDER).useValue(fake)
      },
    })
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    fake.sent.length = 0
    fake.failWith = null
  })

  async function register(name: string, verified = true): Promise<Account> {
    const email = uniqueEmail('inv-mail')
    const response = await request(http())
      .post(url('/auth/register'))
      .send({ email, password: VALID_PASSWORD, displayName: name })
      .expect(201)
    const id = (response.body as { user: { id: string } }).user.id

    if (verified) await prisma.user.update({ where: { id }, data: { emailVerified: true } })

    return { id, cookie: sessionCookie(response.headers), email }
  }

  const invite = (who: Account, email: string) =>
    request(http())
      .post(url('/invitations'))
      .set('Cookie', who.cookie)
      .send({ kind: 'EMAIL', email })

  const accept = (who: Account, token: string) =>
    request(http()).post(url('/invitations/accept')).set('Cookie', who.cookie).send({ token })

  function tokenIn(message: EmailMessage | undefined): string {
    const match = /\/invite#([A-Za-z0-9_%-]+)/.exec(message?.body ?? '')

    if (match?.[1] === undefined) throw new Error('У листі немає посилання-запрошення')

    return decodeURIComponent(match[1])
  }

  const codeOf = (body: unknown): string => apiErrorSchema.parse(body).code
  const fresh = (): string => uniqueEmail('recipient')

  it('надсилає лист із посиланням у фрагменті, відповідь без токена, у БД немає адреси', async () => {
    const inviter = await register('Марта')
    const recipient = fresh()
    const response = await invite(inviter, recipient).expect(201)
    const body = createInvitationResponseSchema.parse(response.body)

    expect(body.token).toBeUndefined()
    expect(body.invitation).toMatchObject({ kind: 'EMAIL', status: 'ACTIVE', maxUses: 1 })

    expect(fake.invites).toHaveLength(1)

    const message = fake.invites[0]

    expect(message?.to).toBe(recipient)
    expect(message?.subject).toContain('Марта')
    expect(message?.body).toMatch(/^.*\/invite#[A-Za-z0-9_-]+$/m)
    expect(message?.body).not.toContain('?token=')
    expect(message?.idempotencyKey).toBe(`invite:${body.invitation.id}`)

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: body.invitation.id } })

    expect(row.tokenHash).toBe(hashToken(tokenIn(message)))
    expect(row.recipientEmailHash).toBe(
      createHmac('sha256', HMAC_SECRET)
        .update(`bookswap-invite-email:v2:${recipient}`)
        .digest('hex'),
    )
    expect(row.recipientEmailHash).not.toBe(createHash('sha256').update(recipient).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(recipient)
    expect(JSON.stringify(row)).not.toContain(tokenIn(message))
  })

  it('лист не містить книжкового вмісту — лише імʼя запрошувача та посилання', async () => {
    const inviter = await register('Приватна')

    await invite(inviter, fresh()).expect(201)

    expect(fake.invites[0]?.body.split('\n').length).toBeLessThan(12)
  })

  it('запрошений за листом реєструється, приймає — і токен більше не працює (одноразовий)', async () => {
    const inviter = await register('Запрошує')
    const recipient = fresh()

    await invite(inviter, recipient).expect(201)

    const token = tokenIn(fake.to(recipient)[0])
    const invitee = await request(http())
      .post(url('/auth/register'))
      .send({ email: recipient, password: VALID_PASSWORD, displayName: 'Нова людина' })
      .expect(201)
    const inviteeAccount: Account = {
      id: (invitee.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(invitee.headers),
      email: recipient,
    }

    await accept(inviteeAccount, token).expect(200)

    expect(
      await prisma.friendship.findFirst({
        where: { status: 'ACCEPTED', OR: [{ userAId: inviter.id }, { userBId: inviter.id }] },
      }),
    ).not.toBeNull()

    const other = await register('Хтось інший')
    const second = await accept(other, token).expect(410)

    expect(codeOf(second.body)).toBe('INVITE_EXHAUSTED')
  })

  it('bearer-правило: лист не прив’язаний до адреси — інший акаунт теж може прийняти (один раз)', async () => {
    const inviter = await register('Bearer')
    const recipient = fresh()
    const other = await register('Не адресат')

    await invite(inviter, recipient).expect(201)
    await accept(other, tokenIn(fake.to(recipient)[0])).expect(200)
  })

  it('збій провайдера: повторна спроба створює НОВЕ запрошення і рахується в ліміт', async () => {
    const inviter = await register('Повтор')
    const recipient = fresh()

    fake.failWith = new Error('down')

    const failed = await invite(inviter, recipient).expect(502)

    expect(failed.body).toMatchObject({ code: 'INVITE_EMAIL_FAILED' })

    fake.failWith = null
    await invite(inviter, recipient).expect(201)

    const rows = await prisma.invitation.findMany({
      where: { inviterId: inviter.id },
      orderBy: { createdAt: 'asc' },
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]?.revokedAt).not.toBeNull()
    expect(rows[1]?.revokedAt).toBeNull()
    expect(rows[0]?.tokenHash).not.toBe(rows[1]?.tokenHash)
  })

  it('відповідь однакова, чи має адреса акаунт: лист іде в обох випадках', async () => {
    const inviter = await register('Без enumeration')
    const existing = await register('Уже є')
    const stranger = fresh()

    const one = await invite(inviter, existing.email).expect(201)
    const two = await invite(inviter, stranger).expect(201)
    const shape = (body: unknown): unknown => {
      const parsed = createInvitationResponseSchema.parse(body)

      return { ...parsed.invitation, id: 'x', createdAt: 'x', expiresAt: 'x' }
    }

    expect(shape(one.body)).toEqual(shape(two.body))
    expect(fake.to(existing.email)).toHaveLength(1)
    expect(fake.to(stranger)).toHaveLength(1)
  })

  it('без підтвердженої пошти — 403 INVITE_EMAIL_UNVERIFIED, нічого не створено й не надіслано', async () => {
    const inviter = await register('Непідтверджена', false)
    const response = await invite(inviter, fresh()).expect(403)

    expect(codeOf(response.body)).toBe('INVITE_EMAIL_UNVERIFIED')
    expect(fake.invites).toHaveLength(0)
    expect(await prisma.invitation.count({ where: { inviterId: inviter.id } })).toBe(0)
  })

  it('посилання (LINK) не потребує підтвердженої пошти', async () => {
    const inviter = await register('Без верифікації', false)

    await request(http())
      .post(url('/invitations'))
      .set('Cookie', inviter.cookie)
      .send({ kind: 'LINK' })
      .expect(201)
  })

  it('ліміт 10 листів на користувача за добу: 11-й — 429 INVITE_RATE_LIMITED, лист не йде', async () => {
    const inviter = await register('Розсилка')

    for (let i = 0; i < 10; i += 1) await invite(inviter, fresh()).expect(201)

    const response = await invite(inviter, fresh()).expect(429)

    expect(codeOf(response.body)).toBe('INVITE_RATE_LIMITED')
    expect(fake.invites).toHaveLength(10)

    // Вікно — доба: старіші запрошення не рахуються.
    await prisma.invitation.updateMany({
      where: { inviterId: inviter.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    })
    await invite(inviter, fresh()).expect(201)
  })

  it('ліміт на одну адресу — 3 за тиждень від усіх запрошувачів; регістр і пробіли не обходять', async () => {
    const recipient = fresh()
    const senders = await Promise.all([
      register('Аня'),
      register('Богдан'),
      register('Віра'),
      register('Гліб'),
    ])

    await invite(senders[0], recipient).expect(201)
    await invite(senders[1], recipient.toUpperCase()).expect(201)
    await invite(senders[2], `  ${recipient}  `).expect(201)

    const response = await invite(senders[3], recipient).expect(429)

    expect(codeOf(response.body)).toBe('INVITE_RATE_LIMITED')
    expect(fake.to(recipient.toLowerCase())).toHaveLength(3)
  })

  it('паралельні запити одного запрошувача не пролазять повз ліміт', async () => {
    const inviter = await register('Паралельна')
    const responses = await Promise.all(Array.from({ length: 14 }, () => invite(inviter, fresh())))

    expect(responses.filter((response) => response.status === 201)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4)
    expect(fake.invites).toHaveLength(10)
  })

  it('збій провайдера: 502 INVITE_EMAIL_FAILED, запис лишається, але погашений — токен не працює', async () => {
    const inviter = await register('Збій')
    const invitee = await register('Отримувач')
    const recipient = fresh()
    const seen: string[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        seen.push(args.map((arg) => JSON.stringify(arg)).join(' '))
      }),
    )

    fake.failWith = new Error(`provider rejected ${recipient}`)

    try {
      const response = await invite(inviter, recipient).expect(502)

      expect(codeOf(response.body)).toBe('INVITE_EMAIL_FAILED')
      expect(JSON.stringify(response.body)).not.toContain(recipient)
      expect(seen.join('\n')).not.toContain(recipient)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    const rows = await prisma.invitation.findMany({ where: { inviterId: inviter.id } })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.revokedAt).not.toBeNull()

    const list = await request(http()).get(url('/invitations')).set('Cookie', inviter.cookie)

    expect(invitationListResponseSchema.parse(list.body).invitations[0]?.status).toBe('REVOKED')
    expect(invitee.id).toBeDefined()
  })

  it('невдала спроба теж рахується до ліміту — провайдер не можна довбати без наслідків', async () => {
    const inviter = await register('Довбання')

    fake.failWith = new Error('down')

    for (let i = 0; i < 10; i += 1) await invite(inviter, fresh()).expect(502)

    expect((await invite(inviter, fresh()).expect(429)).status).toBe(429)
  })

  it('невалідна адреса — 400 і ніщо не створюється', async () => {
    const inviter = await register('Валідація')

    await invite(inviter, 'not-an-email').expect(400)
    await invite(inviter, '').expect(400)
    expect(await prisma.invitation.count({ where: { inviterId: inviter.id } })).toBe(0)
  })

  it('без сесії — 401', async () => {
    await request(http())
      .post(url('/invitations'))
      .send({ kind: 'EMAIL', email: fresh() })
      .expect(401)
  })
})
