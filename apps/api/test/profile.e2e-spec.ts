import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  USER_SEARCH_LIMIT,
  apiErrorSchema,
  meSchema,
  userSearchResponseSchema,
} from '@bookswap/shared'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

describe('Профіль і пошук людей (e2e)', () => {
  let app: INestApplication<App>

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  async function register(
    displayName: string,
    email = uniqueEmail('profile'),
  ): Promise<{ cookie: string; email: string }> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email, password: VALID_PASSWORD, displayName })
      .expect(201)

    return { cookie: sessionCookie(response.headers), email }
  }

  describe('доступ без сесії', () => {
    it.each([
      ['GET', '/me'],
      ['PATCH', '/me'],
      ['GET', '/users?q=Марта'],
      ['GET', '/users?query=Марта'],
    ])('%s %s без кукі — 401 з машиночитним code', async (method, path) => {
      const response = await request(app.getHttpServer())
        [method === 'GET' ? 'get' : 'patch'](url(path))
        .send(method === 'PATCH' ? { bio: 'спроба' } : undefined)
        .expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })
  })

  describe('GET /me', () => {
    it('віддає повний профіль власника за контрактом', async () => {
      const { cookie, email } = await register('Марта Крук')

      const response = await request(app.getHttpServer())
        .get(url('/me'))
        .set('Cookie', cookie)
        .expect(200)

      const me = meSchema.parse(response.body)

      expect(me.email).toBe(email)
      expect(me.displayName).toBe('Марта Крук')
      expect(me.showHolderNames).toBe(true)
      expect(JSON.stringify(response.body)).not.toContain('passwordHash')
    })
  })

  describe('PATCH /me', () => {
    it('змінює всі п’ять полів §6.1', async () => {
      const { cookie } = await register('Олесь')

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({
          displayName: 'Олесь Гнатюк',
          avatarUrl: 'https://cdn.example.com/oles.png',
          bio: 'Читаю фантастику',
          libraryVisibility: 'PUBLIC',
          showHolderNames: false,
        })
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({
        displayName: 'Олесь Гнатюк',
        avatarUrl: 'https://cdn.example.com/oles.png',
        bio: 'Читаю фантастику',
        libraryVisibility: 'PUBLIC',
        showHolderNames: false,
      })
    })

    it('дозволяє занулити аватарку й біо', async () => {
      const { cookie } = await register('Богдан')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ avatarUrl: 'https://cdn.example.com/b.png', bio: 'Текст' })
        .expect(200)

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ avatarUrl: null, bio: null })
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({ avatarUrl: null, bio: null })
    })

    it('не дає змінити email чи emailVerified через профіль', async () => {
      const { cookie, email } = await register('Ярина')

      // whitelist + forbidNonWhitelisted: невідоме поле це помилка, а не тиха втрата.
      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ email: 'inshyj@example.com', emailVerified: true })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)

      const me = await request(app.getHttpServer())
        .get(url('/me'))
        .set('Cookie', cookie)
        .expect(200)

      expect(meSchema.parse(me.body).email).toBe(email)
    })

    it('відхиляє порожнє тіло — 200 на «нічого не змінив» був би брехнею', async () => {
      const { cookie } = await register('Порожній')

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({})
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('відхиляє невідоме значення видимості', async () => {
      const { cookie } = await register('Видимість')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ libraryVisibility: 'SECRET' })
        .expect(400)
    })
  })

  describe('GET /users', () => {
    it('шукає за частиною імені без урахування регістру', async () => {
      const { cookie } = await register('Шукач')
      await register('Северин Наливайко')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ q: 'северин' })
        .set('Cookie', cookie)
        .expect(200)

      const { results } = userSearchResponseSchema.parse(response.body)

      expect(results.map((result) => result.user.displayName)).toContain('Северин Наливайко')
    })

    it('віддає лише імʼя та аватар — §9, «Інший»', async () => {
      const { cookie } = await register('Спостерігач')
      await register('Оксана Приватна')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ q: 'Оксана Приватна' })
        .set('Cookie', cookie)
        .expect(200)

      const [result] = userSearchResponseSchema.parse(response.body).results

      // Сама людина лишається §9-проєкцією «Інший»; `relation` описує стосунок
      // того, хто дивиться, а не приватні дані знайденого.
      expect(Object.keys(result?.user ?? {}).sort()).toEqual(['avatarUrl', 'displayName', 'id'])
      expect(Object.keys(result ?? {}).sort()).toEqual(['relation', 'user'])
    })

    it('позначає стан звʼязку — незнайомець це NONE', async () => {
      const { cookie } = await register('Незнайомий')
      await register('Зовсім Чужий')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ q: 'Зовсім Чужий' })
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(response.body).results[0]?.relation).toBe('NONE')
    })

    it('за email знаходить лише при точному збігу', async () => {
      const { cookie } = await register('Точний')
      const { email } = await register('Знайдений')

      const exact = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ email })
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(exact.body).results).toHaveLength(1)

      // Префікс адреси не має знаходити нікого — інакше пошту можна перебрати
      // по літері, і §6.1 «за email тільки точний збіг» перестає щось означати.
      const [local, domain] = email.split('@')
      const partial = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ email: `${(local ?? '').slice(0, -1)}@${domain ?? ''}` })
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(partial.body).results).toHaveLength(0)
    })

    it('email порівнюється без урахування регістру — так само, як при реєстрації', async () => {
      const { cookie } = await register('Регістр')
      const { email } = await register('Верхній')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ email: email.toUpperCase() })
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(response.body).results).toHaveLength(1)
    })

    it('не показує самого себе', async () => {
      const { cookie, email } = await register('Самотній Унікум')

      const byName = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ q: 'Самотній Унікум' })
        .set('Cookie', cookie)
        .expect(200)

      const byEmail = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ email })
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(byName.body).results).toHaveLength(0)
      expect(userSearchResponseSchema.parse(byEmail.body).results).toHaveLength(0)
    })

    it('вимагає рівно один параметр', async () => {
      const { cookie } = await register('Параметри')

      for (const query of [{}, { q: 'Мар', email: 'a@b.co' }]) {
        const response = await request(app.getHttpServer())
          .get(url('/users'))
          .query(query)
          .set('Cookie', cookie)
          .expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }
    })

    it('не шукає за одним символом', async () => {
      const { cookie } = await register('Односимвольний')

      await request(app.getHttpServer())
        .get(url('/users'))
        .query({ q: 'М' })
        .set('Cookie', cookie)
        .expect(400)
    })
  })

  describe('GET /users?query= — одне поле пошуку', () => {
    async function search(cookie: string, query: Record<string, string>) {
      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query(query)
        .set('Cookie', cookie)
        .expect(200)

      return userSearchResponseSchema.parse(response.body).results
    }

    const names = (results: { user: { displayName: string } }[]) =>
      results.map((result) => result.user.displayName)

    it('шукає частину імені без урахування регістру й обрізає зовнішні пробіли', async () => {
      const { cookie } = await register('Шукач Query')
      await register('Мирослава Кобилянська')

      expect(names(await search(cookie, { query: '  мирослава кобил  ' }))).toEqual([
        'Мирослава Кобилянська',
      ])
    })

    it('повна адреса знаходить людину точно, а частина адреси — нікого', async () => {
      const { cookie } = await register('Шукач Адреси')
      const { email } = await register('Власник Адреси')
      const [local = '', domain = ''] = email.split('@')

      expect(names(await search(cookie, { query: email.toUpperCase() }))).toEqual([
        'Власник Адреси',
      ])

      for (const partial of [local, `${local}@`, `${local.slice(0, -1)}@${domain}`, domain]) {
        expect(await search(cookie, { query: partial })).toEqual([])
      }
    })

    it('не віддає email знайденої за адресою людини — лише §9-проєкцію', async () => {
      const { cookie } = await register('Шукач Проєкції')
      const { email } = await register('Прихована Адреса')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query({ query: email })
        .set('Cookie', cookie)
        .expect(200)

      const [result] = userSearchResponseSchema.parse(response.body).results

      expect(Object.keys(result?.user ?? {}).sort()).toEqual(['avatarUrl', 'displayName', 'id'])
      expect(JSON.stringify(response.body)).not.toContain(email)
    })

    it('обʼєднує збіги імені й адреси: точна адреса першою, без дублікатів', async () => {
      const { cookie } = await register('Шукач Обʼєднання')
      const email = uniqueEmail('union')
      // The owner of the address also has it in the name: matched both ways, listed once.
      // Their name sorts after the other match, so only the email priority puts them first.
      await register(`Я ${email}`, email)
      await register(`А ${email}`)

      expect(names(await search(cookie, { query: email }))).toEqual([`Я ${email}`, `А ${email}`])
    })

    it('застосовує ліміт до фінальної видачі, лишаючи точну адресу першою', async () => {
      const { cookie } = await register('Шукач Ліміту')
      const email = uniqueEmail('limit')

      await register('Власник Лімітної Адреси', email)
      await Promise.all(
        Array.from({ length: USER_SEARCH_LIMIT }, (_, index) =>
          register(`${String(index).padStart(2, '0')} ${email}`),
        ),
      )

      const results = await search(cookie, { query: email })

      expect(results).toHaveLength(USER_SEARCH_LIMIT)
      expect(results[0]?.user.displayName).toBe('Власник Лімітної Адреси')
      expect(new Set(results.map((result) => result.user.id)).size).toBe(USER_SEARCH_LIMIT)
    })

    it('не показує самого себе ні за імʼям, ні за адресою', async () => {
      const { cookie, email } = await register('Самотній Query Унікум')

      expect(await search(cookie, { query: 'Самотній Query Унікум' })).toEqual([])
      expect(await search(cookie, { query: email })).toEqual([])
    })

    it('позначає стан звʼязку з кожним знайденим', async () => {
      const { cookie } = await register('Шукач Звʼязку')
      await register('Незнайомка Query')

      const [result] = await search(cookie, { query: 'Незнайомка Query' })

      expect(result?.relation).toBe('NONE')
    })

    it('приймає адресу найбільшої допустимої довжини', async () => {
      const { cookie } = await register('Шукач Довгої Адреси')
      const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.ua`

      expect(longest).toHaveLength(254)
      expect(await search(cookie, { query: longest })).toEqual([])
    })

    it.each([
      ['один символ після обрізання', { query: ' М ' }],
      ['лише пробіли', { query: '   ' }],
      ['довше за найдовшу адресу', { query: 'а'.repeat(255) }],
      ['query разом із q', { query: 'Мар', q: 'Мар' }],
      ['query разом із email', { query: 'Мар', email: 'a@b.co' }],
      ['усі три разом', { query: 'Мар', q: 'Мар', email: 'a@b.co' }],
    ])('відхиляє %s як помилку валідації', async (_case, query) => {
      const { cookie } = await register('Валідатор Query')

      const response = await request(app.getHttpServer())
        .get(url('/users'))
        .query(query)
        .set('Cookie', cookie)
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })
  })
})
