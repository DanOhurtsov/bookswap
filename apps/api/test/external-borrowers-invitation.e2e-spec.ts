import './helpers/guest-loans-on'
import 'reflect-metadata'
import request from 'supertest'
import { Logger } from '@nestjs/common'
import {
  apiErrorSchema,
  externalBorrowerInvitationResponseSchema,
  externalBorrowerResponseSchema,
} from '@bookswap/shared'
import { createTestApp, uniqueEmail } from './auth.helpers'
import { registerAccount, url, type Account } from './loan.helpers'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import { DevEmailSender } from '../src/email/dev-email-sender'
import { EMAIL_SENDER, type EmailSender } from '../src/email/email-sender'
import { InviteEmailHashCleanupService } from '../src/invitations/invite-email-hash-cleanup.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** Ніколи не резолвиться, ніколи не приймається — саме та поведінка, яку тестує D2. */
class PoisonEmailSender implements EmailSender {
  calls = 0

  send(): Promise<void> {
    this.calls += 1

    return Promise.reject(
      new Error('EMAIL_SENDER не має викликатися гостьовим маршрутом запрошень'),
    )
  }
}

/**
 * Stage 10 (10g): `POST /me/external-borrowers/:id/invitation`. Використовує
 * інфраструктуру Етапу 9 (I1), лише синтетичні дані (D2) і транспорт, що нікуди не
 * відправляє навіть за помилкової конфігурації `EMAIL_SENDER`.
 */
describe('Stage 10 (10g): запрошення гостя (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let poison: PoisonEmailSender
  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): string => apiErrorSchema.parse(body).code

  beforeAll(async () => {
    poison = new PoisonEmailSender()
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EMAIL_SENDER).useValue(poison)
      },
    })
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    poison.calls = 0
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function verifiedOwner(prefix: string): Promise<Account> {
    const owner = await registerAccount(app, prefix)

    await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } })

    return owner
  }

  async function createContact(owner: Account, alias: string): Promise<string> {
    const response = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', owner.cookie)
      .send({ alias, ownerInformed: true })
      .expect(201)

    return externalBorrowerResponseSchema.parse(response.body).contact.id
  }

  const invite = (owner: Account, contactId: string, email: string) =>
    request(http())
      .post(url(`/me/external-borrowers/${contactId}/invitation`))
      .set('Cookie', owner.cookie)
      .send({ email })

  /**
   * Виправлення 10g: у відповіді API токена немає взагалі (Q4) — єдиний спосіб пройти
   * флоу вручну лишається dev-лог `DevEmailSender` (`redactRecipient=true` тепер друкує
   * тіло листа, лише ховаючи адресата). Тест бере посилання рівно звідти, а не зі шпигуна
   * на внутрішньому виклику сервісу — так само, як робив би розробник локально.
   */
  function captureDevLog(): { lines: () => string[] } {
    const lines: string[] = []

    jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '))
    })

    return { lines: () => lines }
  }

  function tokenInLog(lines: string[]): string {
    const match = /\/invite#([A-Za-z0-9_%-]+)/.exec(lines.join('\n'))

    if (match?.[1] === undefined) throw new Error('У dev-логу немає посилання-запрошення')

    return decodeURIComponent(match[1])
  }

  const syntheticEmail = (): string => uniqueEmail('guest10g').replace(/@.*$/, '@guest.invalid')

  it('I1: owner-only, ліміти Етапу 9, лист без alias/назв книжок/фактів позики; посилання — лише з dev-логу', async () => {
    const owner = await verifiedOwner('r10g-i1')
    const contactId = await createContact(owner, 'Синтетичний гість')
    const dev = app.get(DevEmailSender)
    const sendSpy = jest.spyOn(dev, 'send')
    const email = syntheticEmail()
    const log = captureDevLog()

    // Реєстрація сама шле лист підтвердження через глобальний EMAIL_SENDER (poison тут) —
    // це фонове завдання Stage 8/9, не предмет цього тесту. Скидаємо лічильник рівно перед
    // дією, яку перевіряємо.
    poison.calls = 0

    const response = await invite(owner, contactId, email).expect(201)
    const body = externalBorrowerInvitationResponseSchema.parse(response.body)

    expect(body.invitation).toMatchObject({ kind: 'EMAIL', status: 'ACTIVE', maxUses: 1 })
    // Без відлуння email (Q4) — і без токена: посилання доступне лише в dev-логу.
    expect(Object.keys(response.body as object)).toEqual(['invitation'])

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const message = sendSpy.mock.calls[0]?.[0]

    expect(message?.to).toBe(email)
    expect(message?.redactRecipient).toBe(true)
    expect(message?.subject).toContain(owner.displayName)
    expect(message?.body).not.toContain('Синтетичний гість')
    expect(message?.body.split('\n').length).toBeLessThan(12)

    // Транспорт ніколи не бере глобальний EMAIL_SENDER — навіть налаштований на «отруєний».
    expect(poison.calls).toBe(0)

    // Виправлення 10g: dev-лог містить придатне посилання, але не email і не alias.
    const logged = log.lines().join('\n')

    expect(logged).toContain('[приховано]')
    expect(logged).not.toContain(email)
    expect(logged).not.toContain('Синтетичний гість')

    const token = tokenInLog(log.lines())
    const invitee = await registerAccount(app, 'r10g-i1-invitee')

    await request(http())
      .post(url('/invitations/accept'))
      .set('Cookie', invitee.cookie)
      .send({ token })
      .expect(200)

    expect(
      await prisma.friendship.findFirst({
        where: { status: 'ACCEPTED', OR: [{ userAId: owner.id }, { userBId: owner.id }] },
      }),
    ).not.toBeNull()
  })

  it('чужий і відсутній контакт — однаково 404, нічого не створено й не надіслано', async () => {
    const owner = await verifiedOwner('r10g-own')
    const stranger = await verifiedOwner('r10g-stranger')
    const contactId = await createContact(owner, 'Приватний контакт')
    const email = syntheticEmail()

    const foreign = await invite(stranger, contactId, email)
    const missing = await invite(stranger, 'does-not-exist', email)

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(errorCode(foreign.body)).toBe('NOT_FOUND')
    expect(foreign.body).toEqual(missing.body)
    expect(await prisma.invitation.count({ where: { inviterId: stranger.id } })).toBe(0)
  })

  it('лише зарезервований синтетичний домен: реальна адреса — 400, нічого не створено', async () => {
    const owner = await verifiedOwner('r10g-domain')
    const contactId = await createContact(owner, 'Гість')

    const response = await invite(owner, contactId, 'guest@example.com')

    expect(response.status).toBe(400)
    expect(errorCode(response.body)).toBe('VALIDATION_ERROR')
    expect(await prisma.invitation.count({ where: { inviterId: owner.id } })).toBe(0)
  })

  it('I2: сирого email немає в БД, у відповіді API чи в логах', async () => {
    const owner = await verifiedOwner('r10g-i2')
    const contactId = await createContact(owner, 'Гість')
    const dev = app.get(DevEmailSender)
    const email = syntheticEmail()

    const written: string[] = []
    const capture = (chunk: unknown): boolean => {
      written.push(typeof chunk === 'string' ? chunk : String(chunk))

      return true
    }
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture)
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture)

    let response: request.Response

    try {
      response = await invite(owner, contactId, email).expect(201)
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }

    expect(JSON.stringify(response.body)).not.toContain(email)
    expect(written.join('')).not.toContain(email)

    // Q4: жодного сліду в dev-outbox — гостьове повідомлення взагалі туди не потрапляє.
    expect(dev.lastTo(email)).toBeUndefined()
    expect(dev.outbox.some((message) => message.to === email)).toBe(false)

    const body = externalBorrowerInvitationResponseSchema.parse(response.body)
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: body.invitation.id } })

    expect(JSON.stringify(row)).not.toContain(email)
    expect(row.recipientEmailHash).not.toBeNull()
  })

  it('I3: збій відправки → інвайт відкликано одразу, email ніде не лишився', async () => {
    const owner = await verifiedOwner('r10g-i3')
    const contactId = await createContact(owner, 'Гість')
    const dev = app.get(DevEmailSender)
    const email = syntheticEmail()

    jest.spyOn(dev, 'send').mockRejectedValueOnce(new Error(`провайдер відмовив ${email}`))

    const response = await invite(owner, contactId, email)

    expect(response.status).toBe(502)
    expect(errorCode(response.body)).toBe('INVITE_EMAIL_FAILED')
    expect(JSON.stringify(response.body)).not.toContain(email)

    const rows = await prisma.invitation.findMany({ where: { inviterId: owner.id } })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.revokedAt).not.toBeNull()
    expect(dev.outbox.some((message) => message.to === email)).toBe(false)

    // Повторна спроба — нове запрошення, минуле лишається відкликаним.
    const retry = await invite(owner, contactId, email).expect(201)
    const retryBody = externalBorrowerInvitationResponseSchema.parse(retry.body)

    expect(retryBody.invitation.id).not.toBe(rows[0]?.id)
  })

  it('I4/межа 7 діб: до неї хеш живий і ліміт діє; після cleanup — null, інвайт ще чинний', async () => {
    const owner = await verifiedOwner('r10g-i4')
    const contactId = await createContact(owner, 'Гість')
    const email = syntheticEmail()
    const cleanup = app.get(InviteEmailHashCleanupService)
    const log = captureDevLog()

    const response = await invite(owner, contactId, email).expect(201)
    const body = externalBorrowerInvitationResponseSchema.parse(response.body)
    const token = tokenInLog(log.lines())

    const before = await prisma.invitation.findUniqueOrThrow({
      where: { id: body.invitation.id },
    })

    expect(before.recipientEmailHash).not.toBeNull()

    // 89 днів (6 днів — стабільно всередині вікна): ще в межах ліміту, чистка не чіпає.
    await cleanup.run(new Date(before.createdAt.getTime() + 6 * DAY_MS))

    const withinWindow = await prisma.invitation.findUniqueOrThrow({
      where: { id: body.invitation.id },
    })

    expect(withinWindow.recipientEmailHash).toBe(before.recipientEmailHash)

    // Ліміт на цю адресу (3/тиждень) усе ще діє в межах вікна: перше запрошення вище — одне з
    // трьох, ще два вичерпують ліміт, четверте — 429.
    await invite(owner, contactId, email).expect(201)
    await invite(owner, contactId, email).expect(201)
    const blocked = await invite(owner, contactId, email)

    expect(blocked.status).toBe(429)
    expect(errorCode(blocked.body)).toBe('INVITE_RATE_LIMITED')

    // Через 7 днів + запас — за межею вікна: чистка обнуляє хеш.
    await cleanup.run(new Date(before.createdAt.getTime() + WEEK_MS + 1000))

    const after = await prisma.invitation.findUniqueOrThrow({ where: { id: body.invitation.id } })

    expect(after.recipientEmailHash).toBeNull()
    expect(after.tokenHash).toBe(before.tokenHash)
    expect(after.expiresAt).toEqual(before.expiresAt)
    expect(after.revokedAt).toBeNull()

    // Повторний прогін — безпечний (нема чого чистити вдруге, без помилки).
    await cleanup.run(new Date(before.createdAt.getTime() + WEEK_MS + 2000))

    // 14-денний інвайт лишається чинним і приймається попри обнулений хеш.
    const invitee = await registerAccount(app, 'r10g-i4-invitee')

    await request(http())
      .post(url('/invitations/accept'))
      .set('Cookie', invitee.cookie)
      .send({ token })
      .expect(200)

    expect(
      await prisma.friendship.findFirst({
        where: { status: 'ACCEPTED', OR: [{ userAId: owner.id }, { userBId: owner.id }] },
      }),
    ).not.toBeNull()
  })

  it('без підтвердженої пошти власника — 403 INVITE_EMAIL_UNVERIFIED, нічого не створено', async () => {
    const owner = await registerAccount(app, 'r10g-unverified')
    const contactId = await createContact(owner, 'Гість')

    const response = await invite(owner, contactId, syntheticEmail())

    expect(response.status).toBe(403)
    expect(errorCode(response.body)).toBe('INVITE_EMAIL_UNVERIFIED')
    expect(await prisma.invitation.count({ where: { inviterId: owner.id } })).toBe(0)
  })

  it('без сесії — 401', async () => {
    await request(http())
      .post(url('/me/external-borrowers/any-id/invitation'))
      .send({ email: syntheticEmail() })
      .expect(401)
  })

  it('аналітичний факт INVITE_SENT (Етап 9): без alias/email у properties', async () => {
    const owner = await verifiedOwner('r10g-analytics')
    const contactId = await createContact(owner, 'Секретний Аліас')

    const response = await invite(owner, contactId, syntheticEmail()).expect(201)
    const body = externalBorrowerInvitationResponseSchema.parse(response.body)

    const event = await prisma.productEvent.findUnique({
      where: { dedupeKey: computeDedupeKey('INVITE_SENT', body.invitation.id, owner.id) },
    })

    expect(event).not.toBeNull()
    expect(event?.subjectUserId).toBe(owner.id)
    expect(JSON.stringify(event?.properties ?? {})).not.toContain('Секретний Аліас')
  })
})
