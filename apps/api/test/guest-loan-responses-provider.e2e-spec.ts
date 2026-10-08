import './helpers/guest-loans-resend-provider'
import 'reflect-metadata'
import request from 'supertest'
import {
  externalBorrowerResponseSchema,
  guestLoanConfirmationResponseSchema,
} from '@bookswap/shared'
import { createTestApp, uniqueEmail } from './auth.helpers'
import { createShelfCopy, registerAccount, url, type Account } from './loan.helpers'
import { DevEmailSender } from '../src/email/dev-email-sender'
import { EMAIL_SENDER } from '../src/email/email-sender'
import { ResendEmailSender } from '../src/email/resend-email-sender'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, 10i.2 (D2, GC10): за `EMAIL_PROVIDER=resend` токен `EMAIL_SENDER` резолвиться в реальний
 * `ResendEmailSender`, але гостьові маршрути беруть лише `DevEmailSender` — реальний провайдер не
 * викликається ні для листа з посиланням, ні для листа з кодом; `fetch` (єдиний вихід назовні
 * `ResendEmailSender`) не викликається взагалі. Лише синтетичні дані.
 */
describe('Stage 10 (10i.2): гостьові листи не доходять до реального провайдера (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  let fetchMock: jest.Mock
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    // Реєстрація власника надсилає ЗВИЧАЙНИЙ лист підтвердження через `EMAIL_SENDER` (тут — resend), тож
    // `fetch` підмінено ще до неї: реальної мережі в тесті немає. Лічильник обнуляється перед гостьовим потоком.
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
    global.fetch = fetchMock
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 'd2-provider')
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('конфігурація справді обрала resend, але весь гостьовий потік іде через DevEmailSender', async () => {
    const resend = app.get(ResendEmailSender)

    // Sanity: токен у цьому застосунку — саме реальний провайдер (тобто помилка в маршруті була б помітна).
    expect(app.get(EMAIL_SENDER)).toBe(resend)

    const resendSend = jest.spyOn(resend, 'send')

    fetchMock.mockClear()

    const dev = app.get(DevEmailSender)
    const shelf = await createShelfCopy(app, owner)
    const contact = externalBorrowerResponseSchema.parse(
      (
        await request(http())
          .post(url('/me/external-borrowers'))
          .set('Cookie', owner.cookie)
          .send({ alias: 'Гість D2', ownerInformed: true })
          .expect(201)
      ).body,
    ).contact.id
    const confirmation = guestLoanConfirmationResponseSchema.parse(
      (
        await request(http())
          .post(url('/guest-loan-confirmations'))
          .set('Cookie', owner.cookie)
          .send({ copyId: shelf.copyId, externalBorrowerId: contact, handedAt: '2026-01-01' })
          .expect(201)
      ).body,
    ).confirmation
    const a = uniqueEmail('d2-a').replace(/@.*$/, '@guest.invalid')
    const b = uniqueEmail('d2-b').replace(/@.*$/, '@guest.invalid')

    await request(http())
      .post(url(`/guest-loan-confirmations/${confirmation.id}/link`))
      .set('Cookie', owner.cookie)
      .send({ delivery: 'EMAIL', email: a })
      .expect(201)

    const token = /guest-loan-confirmation#([A-Za-z0-9_%-]+)/.exec(dev.sealedTo(a)?.body ?? '')?.[1]

    if (token === undefined) throw new Error('Лист із посиланням не потрапив у dev-транспорт')

    const guest = { token: decodeURIComponent(token), nickname: 'Гість D2', email: b }

    await request(http()).post(url('/guest-loan-responses/code')).send(guest).expect(200)

    const code = /Код підтвердження: (\d{6})/.exec(dev.sealedTo(b)?.body ?? '')?.[1]

    if (code === undefined) throw new Error('Лист із кодом не потрапив у dev-транспорт')

    const proof = (
      (
        await request(http())
          .post(url('/guest-loan-responses/verify'))
          .send({ ...guest, code })
          .expect(200)
      ).body as { proof: string }
    ).proof

    await request(http())
      .post(url('/guest-loan-responses/answer'))
      .send({ ...guest, proof, answer: 'RECEIVED' })
      .expect(200)

    expect(resendSend).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      (await prisma.guestLoanConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } }))
        .status,
    ).toBe('RECEIVED')
  })
})
