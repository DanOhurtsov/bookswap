import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  USER_SEARCH_LIMIT,
  apiErrorSchema,
  handleAvailabilitySchema,
  meSchema,
  publicUserSchema,
  userSearchResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

const GENERATED_HANDLE = /^user\d{8}$/

let handleSeq = 0

/** Unique within the shared e2e database: one run, many files, every nickname once. */
function uniqueHandle(prefix: string): string {
  handleSeq += 1

  return `${prefix}-${Date.now().toString(36)}${String(handleSeq)}`
}

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
      ['GET', '/users/handles/marta/availability'],
      ['GET', '/users/handles/marta'],
      ['GET', '/users/some-user-id'],
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
    // BS-148: the photo left this body for `POST /me/avatar` (test/avatar.e2e-spec.ts).
    it('змінює поля профілю §6.1', async () => {
      const { cookie } = await register('Олесь')

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({
          displayName: 'Олесь Гнатюк',
          bio: 'Читаю фантастику',
          libraryVisibility: 'PUBLIC',
          showHolderNames: false,
        })
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({
        displayName: 'Олесь Гнатюк',
        bio: 'Читаю фантастику',
        libraryVisibility: 'PUBLIC',
        showHolderNames: false,
      })
    })

    it('дозволяє занулити біо', async () => {
      const { cookie } = await register('Богдан')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ bio: 'Текст' })
        .expect(200)

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ bio: null })
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({ bio: null })
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

    it('віддає лише імʼя, нік (BS-148) та аватар — §9, «Інший»', async () => {
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
      expect(Object.keys(result?.user ?? {}).sort()).toEqual([
        'avatarUrl',
        'displayName',
        'handle',
        'id',
      ])
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

      expect(Object.keys(result?.user ?? {}).sort()).toEqual([
        'avatarUrl',
        'displayName',
        'handle',
        'id',
      ])
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

  describe('BS-148: нік і місто', () => {
    async function me(cookie: string) {
      const response = await request(app.getHttpServer())
        .get(url('/me'))
        .set('Cookie', cookie)
        .expect(200)

      return meSchema.parse(response.body)
    }

    async function availability(cookie: string, handle: string) {
      const response = await request(app.getHttpServer())
        .get(url(`/users/handles/${encodeURIComponent(handle)}/availability`))
        .set('Cookie', cookie)
        .expect(200)

      return handleAvailabilitySchema.parse(response.body).available
    }

    it('реєстрація видає згенерований нік, місто порожнє', async () => {
      const { cookie } = await register('Нова людина')

      const profile = await me(cookie)

      expect(profile.handle).toMatch(GENERATED_HANDLE)
      expect(profile.city).toBeNull()
    })

    it('змінює нік і місто: обрізає, зводить нік до нижнього регістру; місто можна занулити', async () => {
      const { cookie } = await register('Данило')
      const handle = uniqueHandle('danylo')

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ handle: `  ${handle.toUpperCase()} `, city: '  Вроцлав ' })
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({ handle, city: 'Вроцлав' })

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ city: null })
        .expect(200)

      expect(await me(cookie)).toMatchObject({ handle, city: null })
    })

    it('місто з самих пробілів зберігається як null, не як порожній рядок', async () => {
      const { cookie } = await register('Мирослава')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ city: 'Львів' })
        .expect(200)

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ city: '   ' })
        .expect(200)

      expect(meSchema.parse(response.body).city).toBeNull()
    })

    it('чужий нік — 409 HANDLE_TAKEN, профіль не змінюється', async () => {
      const taken = uniqueHandle('taken')
      const owner = await register('Власник ніка')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', owner.cookie)
        .send({ handle: taken })
        .expect(200)

      const { cookie } = await register('Інша людина')
      const before = await me(cookie)

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ handle: taken, city: 'Київ' })
        .expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.HANDLE_TAKEN)
      expect(await me(cookie)).toEqual(before)
    })

    it('зарезервований нік відповідає так само, як зайнятий', async () => {
      const { cookie } = await register('Хтось')

      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ handle: 'Admin' })
        .expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.HANDLE_TAKEN)
    })

    it.each([['ab'], ['-edge'], ['two--seps'], ['данило'], [null]])(
      'нік %p поза форматом — 400 VALIDATION_ERROR',
      async (handle) => {
        const { cookie } = await register('Формат')

        const response = await request(app.getHttpServer())
          .patch(url('/me'))
          .set('Cookie', cookie)
          .send({ handle })
          .expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      },
    )

    it('задовге місто — 400 VALIDATION_ERROR', async () => {
      const { cookie } = await register('Місто')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ city: 'м'.repeat(61) })
        .expect(400)
    })

    it('availability: вільний, свій, чужий, зарезервований; регістр не важить', async () => {
      const mine = uniqueHandle('mine')
      const theirs = uniqueHandle('theirs')
      const owner = await register('Чужий')
      const { cookie } = await register('Ярема')

      for (const [session, handle] of [
        [owner.cookie, theirs],
        [cookie, mine],
      ] as const) {
        await request(app.getHttpServer())
          .patch(url('/me'))
          .set('Cookie', session)
          .send({ handle })
          .expect(200)
      }

      expect(await availability(cookie, uniqueHandle('free'))).toBe(true)
      expect(await availability(cookie, mine.toUpperCase())).toBe(true)
      expect(await availability(cookie, theirs)).toBe(false)
      expect(await availability(cookie, 'bookswap')).toBe(false)
    })

    it('availability: нік поза форматом — 400, а не «зайнято»', async () => {
      const { cookie } = await register('Перевірка')

      const response = await request(app.getHttpServer())
        .get(url('/users/handles/a--b/availability'))
        .set('Cookie', cookie)
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('нік є в публічній проєкції людини (пошук людей)', async () => {
      const name = `Нікова ${Date.now().toString(36)}`
      const handle = uniqueHandle('public')
      const target = await register(name)

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', target.cookie)
        .send({ handle })
        .expect(200)

      const { cookie } = await register('Шукач')
      const response = await request(app.getHttpServer())
        .get(url(`/users?q=${encodeURIComponent(name)}`))
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(response.body).results.map((r) => r.user)).toEqual([
        expect.objectContaining({ displayName: name, handle }),
      ])
    })

    it('пошук людей за ніком не шукає', async () => {
      const handle = uniqueHandle('hidden')
      const target = await register('Без збігу в імені')

      await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', target.cookie)
        .send({ handle })
        .expect(200)

      const { cookie } = await register('Шукач')
      const response = await request(app.getHttpServer())
        .get(url(`/users?query=${encodeURIComponent(handle)}`))
        .set('Cookie', cookie)
        .expect(200)

      expect(userSearchResponseSchema.parse(response.body).results).toEqual([])
    })

    /**
     * The database draws the nickname; a draw that hits an existing one must not surface as
     * EMAIL_TAKEN (the old catch-all) — registration draws again. The generator is swapped for one
     * that collides exactly once, then restored to the migration's definition.
     */
    it('колізія згенерованого ніка — реєстрація повторює вставку, а не відповідає EMAIL_TAKEN', async () => {
      const prisma = app.get(PrismaService)
      const existing = await me((await register('Перший')).cookie)

      await prisma.$executeRawUnsafe(`CREATE SEQUENCE bs148_handle_collision`)
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION generate_user_handle() RETURNS text LANGUAGE sql VOLATILE AS $$
          SELECT CASE WHEN nextval('bs148_handle_collision') = 1 THEN '${existing.handle}'
                      ELSE 'user' || lpad(floor(random() * 100000000)::bigint::text, 8, '0') END
        $$
      `)

      try {
        const { cookie } = await register('Другий')
        const second = await me(cookie)

        expect(second.handle).toMatch(GENERATED_HANDLE)
        expect(second.handle).not.toBe(existing.handle)
      } finally {
        await prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION generate_user_handle() RETURNS text LANGUAGE sql VOLATILE AS $$
            SELECT 'user' || lpad(floor(random() * 100000000)::bigint::text, 8, '0')
          $$
        `)
        await prisma.$executeRawUnsafe(`DROP SEQUENCE bs148_handle_collision`)
      }
    })
  })

  describe('BS-148: адреса людини /u/<нік>', () => {
    type Person = { cookie: string; id: string; handle: string; displayName: string }

    /** A registered person with a nickname of their own, as `/u/<handle>` would show it. */
    async function person(displayName: string): Promise<Person> {
      const { cookie } = await register(displayName)
      const handle = uniqueHandle('person')
      const response = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', cookie)
        .send({ handle })
        .expect(200)
      const { id } = meSchema.parse(response.body)

      return { cookie, id, handle, displayName }
    }

    function byHandle(viewer: Person, handle: string): request.Test {
      return request(app.getHttpServer())
        .get(url(`/users/handles/${encodeURIComponent(handle)}`))
        .set('Cookie', viewer.cookie)
    }

    function byId(viewer: Person, id: string): request.Test {
      return request(app.getHttpServer())
        .get(url(`/users/${encodeURIComponent(id)}`))
        .set('Cookie', viewer.cookie)
    }

    async function block(blocker: Person, blocked: Person): Promise<void> {
      await request(app.getHttpServer())
        .post(url(`/friends/${blocked.id}/block`))
        .set('Cookie', blocker.cookie)
        .expect(204)
    }

    it('за ніком — лише публічна проєкція людини; регістр і пробіли не важать', async () => {
      const viewer = await person('Глядачка')
      const owner = await person('Власниця')

      const exact = await byHandle(viewer, owner.handle).expect(200)

      expect(exact.body).toEqual({
        id: owner.id,
        displayName: owner.displayName,
        handle: owner.handle,
        avatarUrl: null,
      })

      const shouted = await byHandle(viewer, ` ${owner.handle.toUpperCase()} `).expect(200)

      expect(publicUserSchema.parse(shouted.body).id).toBe(owner.id)
    })

    it('за id — та сама проєкція, з ніком для переадресації', async () => {
      const viewer = await person('Глядач')
      const owner = await person('Власник')

      const response = await byId(viewer, owner.id).expect(200)

      expect(response.body).toEqual({
        id: owner.id,
        displayName: owner.displayName,
        handle: owner.handle,
        avatarUrl: null,
      })
    })

    it('свій нік і свій id знаходять себе', async () => {
      const self = await person('Сама')

      expect(publicUserSchema.parse((await byHandle(self, self.handle).expect(200)).body).id).toBe(
        self.id,
      )
      expect(publicUserSchema.parse((await byId(self, self.id).expect(200)).body).id).toBe(self.id)
    })

    it('невідомий нік і невідомий id — 404 NOT_FOUND', async () => {
      const viewer = await person('Шукачка')

      const unknownHandle = await byHandle(viewer, uniqueHandle('nobody')).expect(404)
      const unknownId = await byId(viewer, 'no-such-user').expect(404)

      expect(apiErrorSchema.parse(unknownHandle.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
      expect(apiErrorSchema.parse(unknownId.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })

    it('заблокована пара в будь-який бік відповідає так само, як невідома людина', async () => {
      const blocker = await person('Блокувальниця')
      const blocked = await person('Заблокований')

      await block(blocker, blocked)

      const unknown = await byHandle(blocked, uniqueHandle('nobody')).expect(404)

      for (const [viewer, target] of [
        [blocked, blocker],
        [blocker, blocked],
      ] as const) {
        const handleResponse = await byHandle(viewer, target.handle).expect(404)
        const idResponse = await byId(viewer, target.id).expect(404)

        expect(handleResponse.body).toEqual(unknown.body)
        expect(idResponse.body).toEqual(unknown.body)
      }
    })

    it('нік поза форматом — 400, а не пошук', async () => {
      const viewer = await person('Перевіряльниця')

      const response = await byHandle(viewer, 'a--b').expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('`library` зарезервований: /users/handles/library не перетинається з /users/:id/library', async () => {
      const viewer = await person('Бібліотекарка')

      const taken = await request(app.getHttpServer())
        .patch(url('/me'))
        .set('Cookie', viewer.cookie)
        .send({ handle: 'library' })
        .expect(409)

      expect(apiErrorSchema.parse(taken.body).code).toBe(API_ERROR_CODES.HANDLE_TAKEN)

      const lookup = await byHandle(viewer, 'library').expect(404)

      expect(apiErrorSchema.parse(lookup.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })
  })

  describe('BS-148: налаштування позичання', () => {
    function patchMe(cookie: string, body: object): request.Test {
      return request(app.getHttpServer()).patch(url('/me')).set('Cookie', cookie).send(body)
    }

    it('новий акаунт: друзі друзів закриті, пауз немає, терміну немає, нагадування ввімкнені', async () => {
      const { cookie } = await register('Нова людина')

      const response = await request(app.getHttpServer())
        .get(url('/me'))
        .set('Cookie', cookie)
        .expect(200)

      expect(meSchema.parse(response.body)).toMatchObject({
        friendsOfFriendsAccess: false,
        loanRequestsPaused: false,
        defaultLoanTermDays: null,
        ownerDueReminders: true,
      })
    })

    it('змінює кожне налаштування окремо й зберігає його; термін можна скинути', async () => {
      const { cookie } = await register('Марта')

      await patchMe(cookie, { friendsOfFriendsAccess: true }).expect(200)
      await patchMe(cookie, { loanRequestsPaused: true }).expect(200)
      await patchMe(cookie, { ownerDueReminders: false }).expect(200)

      const withTerm = await patchMe(cookie, { defaultLoanTermDays: 21 }).expect(200)

      expect(meSchema.parse(withTerm.body)).toMatchObject({
        friendsOfFriendsAccess: true,
        loanRequestsPaused: true,
        defaultLoanTermDays: 21,
        ownerDueReminders: false,
      })

      const cleared = await patchMe(cookie, { defaultLoanTermDays: null }).expect(200)

      expect(meSchema.parse(cleared.body).defaultLoanTermDays).toBeNull()
    })

    it.each([
      ['термін поза переліком', { defaultLoanTermDays: 7 }],
      ['термін рядком', { defaultLoanTermDays: '14' }],
      ['перемикач null', { loanRequestsPaused: null }],
      ['перемикач рядком', { friendsOfFriendsAccess: 'true' }],
    ])('%s — 400 VALIDATION_ERROR, профіль не змінюється', async (_name, body) => {
      const { cookie } = await register('Тарас')

      const response = await patchMe(cookie, body).expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)

      const after = await request(app.getHttpServer())
        .get(url('/me'))
        .set('Cookie', cookie)
        .expect(200)

      expect(meSchema.parse(after.body)).toMatchObject({
        friendsOfFriendsAccess: false,
        loanRequestsPaused: false,
        defaultLoanTermDays: null,
      })
    })

    it('база сама не приймає термін поза переліком (CHECK user_default_loan_term_days)', async () => {
      const { email } = await register('Олена')
      const prisma = app.get(PrismaService)

      await expect(
        prisma.$executeRaw`UPDATE "User" SET "defaultLoanTermDays" = 7 WHERE "email" = ${email}`,
      ).rejects.toThrow(/user_default_loan_term_days/)
    })
  })
})
