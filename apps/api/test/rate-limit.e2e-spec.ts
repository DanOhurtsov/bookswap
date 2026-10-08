import './helpers/guest-loans-on'
import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import { API_ERROR_CODES, API_PREFIX, apiErrorSchema } from '@bookswap/shared'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

/**
 * §11: rate limiting на чутливих ендпоінтах.
 *
 * Єдиний e2e-файл, який піднімає застосунок зі справжнім throttler'ом — решта
 * його вимикає, бо ліміт реєстрацій нижчий за кількість сценаріїв. Тому тут і
 * перевіряється, що ліміт узагалі існує: інакше «вимкнено в тестах» непомітно
 * перетворилося б на «вимкнено скрізь».
 */
describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>

  beforeAll(async () => {
    app = await createTestApp({ withRateLimit: true })
  })

  afterAll(async () => {
    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  it('логін відсікається після серії невдалих спроб', async () => {
    const email = uniqueEmail('brute')
    const statuses: number[] = []

    // Ліміт логіну — 10 за 15 хвилин; 12 спроб мусять упертися в стелю.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: 'nepravylnyj-parol' })

      statuses.push(response.status)
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)

    const last = await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: VALID_PASSWORD })
      .expect(429)

    expect(apiErrorSchema.parse(last.body).code).toBe(API_ERROR_CODES.TOO_MANY_REQUESTS)
  })

  it('запити в друзі відсікаються після ліміту (§11)', async () => {
    // Реєстрація теж під лімітом (5/год), тож акаунт тут рівно один, а запити
    // йдуть на один і той самий неіснуючий id: throttler рахує звернення, а не
    // їхній результат, тож 404 у відповідях справі не заважають.
    const email = uniqueEmail('friend-limit')
    const registration = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email, password: VALID_PASSWORD, displayName: 'Настирливий' })
      .expect(201)

    const cookie = sessionCookie(registration.headers)
    const statuses: number[] = []

    // Ліміт — 30 на годину; 32 звернення мусять упертися в стелю.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post(url('/friends/requests'))
        .set('Cookie', cookie)
        .send({ userId: 'ckl0000000000000000000000' })

      statuses.push(response.status)
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)

    const last = await request(app.getHttpServer())
      .post(url('/friends/requests'))
      .set('Cookie', cookie)
      .send({ userId: 'ckl0000000000000000000000' })
      .expect(429)

    expect(apiErrorSchema.parse(last.body).code).toBe(API_ERROR_CODES.TOO_MANY_REQUESTS)
  })

  it('запрошення гостя (10g) відсікається після ліміту, той самий, що й у /invitations', async () => {
    const email = uniqueEmail('throttle-guest-invite')
    const registration = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email, password: VALID_PASSWORD, displayName: 'Настирливий власник' })
      .expect(201)

    const cookie = sessionCookie(registration.headers)
    const statuses: number[] = []

    // Контакту з таким id не існує — кожен запит падає на 404 в handler'і, не витрачаючи
    // жодного доменного ліміту Етапу 9 (перевірка контакту йде до InvitationsService).
    // Ліміт — 30 на годину; 32 звернення мусять упертися в стелю.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post(url('/me/external-borrowers/does-not-exist/invitation'))
        .set('Cookie', cookie)
        .send({ email: 'guest@guest.invalid' })

      statuses.push(response.status)
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)

    const last = await request(app.getHttpServer())
      .post(url('/me/external-borrowers/does-not-exist/invitation'))
      .set('Cookie', cookie)
      .send({ email: 'guest@guest.invalid' })
      .expect(429)

    expect(apiErrorSchema.parse(last.body).code).toBe(API_ERROR_CODES.TOO_MANY_REQUESTS)
  })

  it('health лишається без ліміту — throttler висить лише на чутливому', async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(app.getHttpServer()).get(url('/health')).expect(200)
    }
  })
})
