import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  EMAIL_DOMAIN_BLOCKED_MESSAGE,
  apiErrorSchema,
  sessionResponseSchema,
} from '@bookswap/shared'
import { AnalyticsService } from '../src/analytics/analytics.service'
import { AuthService } from '../src/auth/auth.service'
import { PasswordService } from '../src/auth/password.service'
import { SessionService } from '../src/auth/session.service'
import { ApiException } from '../src/common/api.exception'
import { DevEmailSender } from '../src/email/dev-email-sender'
import { PrismaService } from '../src/prisma/prisma.service'
import {
  VALID_PASSWORD,
  cookiesOf,
  createTestApp,
  sessionCookie,
  tokenFromLastEmail,
  uniqueEmail,
} from './auth.helpers'

/**
 * BS-129: a new account cannot be created on a blocked email domain, while an
 * existing account on such a domain keeps every auth flow. All of it goes through
 * the real `POST /api/v1/auth/register` (DTO, pipe, filter) and the real database.
 */
describe('Registration email domain policy (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let email: DevEmailSender
  let auth: AuthService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    email = app.get(DevEmailSender)
    auth = app.get(AuthService)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  const normalized = (address: string): string => address.trim().toLowerCase()

  /** `uniqueEmail()` with its `example.com` domain swapped for `domain`. */
  const addressOn = (domain: string, prefix = 'bs129'): string =>
    uniqueEmail(prefix).replace('@example.com', `@${domain}`)

  /**
   * Totals of every row a registration writes. e2e files run one at a time
   * (`maxWorkers: 1`), so a before/after comparison inside one test is exact.
   * The dev outbox is capped, so emails are checked per address instead.
   */
  async function footprint(): Promise<Record<string, number>> {
    const [users, sessions, verificationTokens, signups] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.emailVerificationToken.count(),
      prisma.productEvent.count({ where: { type: 'SIGNUP_COMPLETED' } }),
    ])

    return { users, sessions, verificationTokens, signups }
  }

  describe('POST /auth/register on a blocked domain', () => {
    it.each([
      ['ASCII .ru', () => addressOn('example.ru')],
      ['subdomain of .su', () => addressOn('mail.corp.example.su')],
      ['mixed case and outer spaces, .moscow', () => `  ${addressOn('Mail.Example.MOSCOW')}  `],
      ['Unicode .рф', () => addressOn('пошта.рф')],
      ['Punycode .рф', () => addressOn('xn--80a1acn3a.xn--p1ai')],
      ['Unicode .рус', () => addressOn('книги.рус')],
      ['Punycode .рус', () => addressOn('example.XN--P1ACF')],
      ['Unicode .москва', () => addressOn('пошта.МОСКВА')],
      ['Punycode .москва', () => addressOn('example.xn--80adxhks')],
    ])('%s: 400 EMAIL_DOMAIN_BLOCKED with nothing created', async (_case, makeAddress) => {
      const address = makeAddress()
      const before = await footprint()

      const response = await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({ email: address, password: VALID_PASSWORD, displayName: 'Марта' })
        .expect(400)

      await auth.drainBackgroundWork()

      expect(apiErrorSchema.parse(response.body)).toEqual({
        code: API_ERROR_CODES.EMAIL_DOMAIN_BLOCKED,
        message: EMAIL_DOMAIN_BLOCKED_MESSAGE,
      })
      expect(cookiesOf(response.headers).some((c) => c.startsWith('bookswap_session='))).toBe(false)
      await expect(
        prisma.user.findUnique({ where: { email: normalized(address) } }),
      ).resolves.toBeNull()
      expect(email.lastTo(normalized(address))).toBeUndefined()
      await expect(footprint()).resolves.toEqual(before)
    })
  })

  it('a direct AuthService.register() call is refused before the hash and every side effect', async () => {
    const address = `  ${addressOn('Mail.Example.RU')} `
    const before = await footprint()
    const hash = jest.spyOn(app.get(PasswordService), 'hash')
    const createSession = jest.spyOn(app.get(SessionService), 'create')
    const record = jest.spyOn(app.get(AnalyticsService), 'record')

    const refusal = await auth
      .register({ email: address, password: VALID_PASSWORD, displayName: 'Марта' })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    await auth.drainBackgroundWork()

    expect(refusal).toBeInstanceOf(ApiException)
    expect((refusal as ApiException).getStatus()).toBe(400)
    expect((refusal as ApiException).getResponse()).toEqual({
      code: API_ERROR_CODES.EMAIL_DOMAIN_BLOCKED,
      message: EMAIL_DOMAIN_BLOCKED_MESSAGE,
    })
    expect(hash).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(email.lastTo(normalized(address))).toBeUndefined()
    await expect(footprint()).resolves.toEqual(before)
  })

  describe('allowed addresses keep the current registration', () => {
    it.each([
      ['a .ru label that is not the suffix', () => addressOn('example.ru.com')],
      ['ru in the local part', () => `ru.${uniqueEmail('local')}`],
      ['a Punycode domain under .com', () => addressOn('xn--e1afmkfd.com')],
    ])(
      '%s: normalized, session, verification email and SIGNUP_COMPLETED',
      async (_case, makeAddress) => {
        const address = makeAddress()

        const response = await request(app.getHttpServer())
          .post(url('/auth/register'))
          .send({
            email: `  ${address.toUpperCase()} `,
            password: VALID_PASSWORD,
            displayName: 'Марта',
          })
          .expect(201)

        await auth.drainBackgroundWork()

        const { user } = sessionResponseSchema.parse(response.body)

        expect(user.email).toBe(address)
        expect(user.emailVerified).toBe(false)
        expect(sessionCookie(response.headers)).toContain('bookswap_session=')
        await expect(prisma.session.count({ where: { userId: user.id } })).resolves.toBe(1)
        await expect(
          prisma.productEvent.count({
            where: { subjectUserId: user.id, type: 'SIGNUP_COMPLETED' },
          }),
        ).resolves.toBe(1)

        const confirmed = await request(app.getHttpServer())
          .post(url('/auth/email-verification/confirm'))
          .send({ token: tokenFromLastEmail(email, address) })
          .expect(200)

        expect(sessionResponseSchema.parse(confirmed.body).user.emailVerified).toBe(true)
      },
    )

    it('after a refusal, the same person registers with an allowed address', async () => {
      const blocked = addressOn('example.ru', 'retry')
      const allowed = blocked.replace('@example.ru', '@example.com')

      await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({ email: blocked, password: VALID_PASSWORD, displayName: 'Марта' })
        .expect(400)

      const response = await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({ email: allowed, password: VALID_PASSWORD, displayName: 'Марта' })
        .expect(201)

      expect(sessionResponseSchema.parse(response.body).user.email).toBe(allowed)
    })
  })

  /**
   * The fixture is written straight to the database, as an account created before
   * BS-129 would be: the registration policy is not loosened to make it.
   */
  describe('an existing account on a blocked domain', () => {
    it.each([
      ['ASCII .ru', () => addressOn('example.ru', 'legacy')],
      ['Unicode .рф', () => addressOn('пошта.рф', 'legacy')],
    ])('%s: login, session, email verification and password reset', async (_case, makeAddress) => {
      const address = makeAddress()

      await prisma.user.create({
        data: {
          email: address,
          passwordHash: await app.get(PasswordService).hash(VALID_PASSWORD),
          displayName: 'Давній Користувач',
        },
      })

      const login = await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: address.toUpperCase(), password: VALID_PASSWORD })
        .expect(200)
      const cookie = sessionCookie(login.headers)

      const session = await request(app.getHttpServer())
        .get(url('/auth/session'))
        .set('Cookie', cookie)
        .expect(200)

      expect(sessionResponseSchema.parse(session.body).user.email).toBe(address)

      await request(app.getHttpServer())
        .post(url('/auth/email-verification'))
        .set('Cookie', cookie)
        .expect(202)
      await auth.drainBackgroundWork()

      const verified = await request(app.getHttpServer())
        .post(url('/auth/email-verification/confirm'))
        .send({ token: tokenFromLastEmail(email, address) })
        .expect(200)

      expect(sessionResponseSchema.parse(verified.body).user.emailVerified).toBe(true)

      await request(app.getHttpServer())
        .post(url('/auth/password-reset'))
        .send({ email: address })
        .expect(202)
      await auth.drainBackgroundWork()

      const newPassword = 'novyj-parol-bs129-2026'

      await request(app.getHttpServer())
        .post(url('/auth/password-reset/confirm'))
        .send({ token: tokenFromLastEmail(email, address), password: newPassword })
        .expect(204)

      await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: address, password: newPassword })
        .expect(200)
    })
  })
})
