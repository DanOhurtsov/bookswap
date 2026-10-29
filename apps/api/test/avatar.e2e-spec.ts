import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import sharp from 'sharp'
import {
  API_ERROR_CODES,
  API_PREFIX,
  AVATAR_RULES,
  apiErrorSchema,
  meSchema,
  type Me,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

/**
 * BS-148, sub-stage C: the profile photo on `AVATAR_STORAGE=memory` — the store `createTestApp()`
 * gets by default, the same one a fresh clone runs with.
 */
describe('Фото профілю (e2e, BS-148)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  type Account = { id: string; cookie: string }

  async function register(displayName: string): Promise<Account> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email: uniqueEmail('avatar'), password: VALID_PASSWORD, displayName })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  function photo(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: '#1e6845' } })
      .jpeg()
      .toBuffer()
  }

  function upload(account: Account, bytes: Buffer, contentType = 'image/jpeg'): request.Test {
    return request(app.getHttpServer())
      .post(url('/me/avatar'))
      .set('Cookie', account.cookie)
      .set('Content-Type', contentType)
      .send(bytes)
  }

  function removeAvatar(account: Account): request.Test {
    return request(app.getHttpServer()).delete(url('/me/avatar')).set('Cookie', account.cookie)
  }

  /** The photo at the address the profile now holds, fetched the way a browser's `<img>` would. */
  function served(avatarUrl: string): request.Test {
    return request(app.getHttpServer()).get(new URL(avatarUrl).pathname)
  }

  function errorCode(body: unknown): string {
    return apiErrorSchema.parse(body).code
  }

  async function storedAvatarUrl(account: Account): Promise<string | null> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: account.id } })

    return row.avatarUrl
  }

  it('без сесії — 401 на завантаження й видалення', async () => {
    const bytes = await photo(300, 300)

    await request(app.getHttpServer())
      .post(url('/me/avatar'))
      .set('Content-Type', 'image/jpeg')
      .send(bytes)
      .expect(401)
    await request(app.getHttpServer()).delete(url('/me/avatar')).expect(401)
  })

  it('зберігає центрований квадрат WebP і повертає профіль з адресою фото', async () => {
    const marta = await register('Марта')

    const response = await upload(marta, await photo(900, 600)).expect(200)
    const me: Me = meSchema.parse(response.body)

    expect(me.avatarUrl).toMatch(
      new RegExp(`${API_PREFIX}/avatars/${marta.id}/[0-9a-f-]{36}\\.webp$`),
    )
    expect(await storedAvatarUrl(marta)).toBe(me.avatarUrl)

    const image = await served(me.avatarUrl ?? '')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []

        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          done(null, Buffer.concat(chunks))
        })
      })
      .expect(200)

    expect(image.headers['content-type']).toBe('image/webp')
    expect(image.headers['cache-control']).toContain('immutable')

    const { format, width, height } = await sharp(image.body as Buffer).metadata()

    expect({ format, width, height }).toEqual({
      format: 'webp',
      width: AVATAR_RULES.side,
      height: AVATAR_RULES.side,
    })
  })

  it('тип визначають байти, а не Content-Type: JPEG під іншим заголовком приймається', async () => {
    const oles = await register('Олесь')

    // JPEG bytes under three other labels. (Not `application/json`: superagent would serialize the
    // Buffer itself into JSON text, and the server would rightly see no photo.)
    for (const contentType of ['application/octet-stream', 'image/png', 'text/plain']) {
      await upload(oles, await photo(400, 400), contentType).expect(200)
    }
  })

  it('нове фото замінює старе, а старе зникає зі сховища', async () => {
    const ira = await register('Ірина')
    const first = meSchema.parse((await upload(ira, await photo(400, 400)).expect(200)).body)
    const second = meSchema.parse((await upload(ira, await photo(500, 500)).expect(200)).body)

    expect(second.avatarUrl).not.toBe(first.avatarUrl)
    await served(second.avatarUrl ?? '').expect(200)
    await served(first.avatarUrl ?? '').expect(404)
  })

  it('видалення прибирає фото з профілю й зі сховища; повторне — теж 200', async () => {
    const taras = await register('Тарас')
    const uploaded = meSchema.parse((await upload(taras, await photo(400, 400)).expect(200)).body)

    const removed = meSchema.parse((await removeAvatar(taras).expect(200)).body)

    expect(removed.avatarUrl).toBeNull()
    expect(await storedAvatarUrl(taras)).toBeNull()
    await served(uploaded.avatarUrl ?? '').expect(404)

    expect(meSchema.parse((await removeAvatar(taras).expect(200)).body).avatarUrl).toBeNull()
  })

  it('зовнішня адреса з часів до BS-148 замінюється й прибирається без спроб її «видалити»', async () => {
    const legacy = await register('Давня')

    await prisma.user.update({
      where: { id: legacy.id },
      data: { avatarUrl: 'https://cdn.example.com/legacy.png' },
    })

    const replaced = meSchema.parse((await upload(legacy, await photo(400, 400)).expect(200)).body)

    expect(replaced.avatarUrl).not.toBe('https://cdn.example.com/legacy.png')

    await prisma.user.update({
      where: { id: legacy.id },
      data: { avatarUrl: 'https://cdn.example.com/legacy.png' },
    })

    expect(meSchema.parse((await removeAvatar(legacy).expect(200)).body).avatarUrl).toBeNull()
  })

  it('більше за ліміт — 413 AVATAR_TOO_LARGE, профіль не змінюється', async () => {
    const big = await register('Велика')
    const bytes = Buffer.concat([await photo(400, 400), Buffer.alloc(AVATAR_RULES.maxBytes)])

    const response = await upload(big, bytes).expect(413)

    expect(errorCode(response.body)).toBe(API_ERROR_CODES.AVATAR_TOO_LARGE)
    expect(await storedAvatarUrl(big)).toBeNull()
  })

  it('не JPEG/PNG/WebP — 415 AVATAR_UNSUPPORTED_TYPE, навіть під заголовком image/png', async () => {
    const odd = await register('Дивна')
    const gif = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#000' },
    })
      .gif()
      .toBuffer()

    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), gif]) {
      const response = await upload(odd, bytes, 'image/png').expect(415)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE)
    }

    const empty = await request(app.getHttpServer())
      .post(url('/me/avatar'))
      .set('Cookie', odd.cookie)
      .expect(415)

    expect(errorCode(empty.body)).toBe(API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE)
    expect(await storedAvatarUrl(odd)).toBeNull()
  })

  it('коротша сторона менша за мінімум — 422 AVATAR_TOO_SMALL', async () => {
    const small = await register('Мала')

    const response = await upload(small, await photo(AVATAR_RULES.minSide - 1, 1000)).expect(422)

    expect(errorCode(response.body)).toBe(API_ERROR_CODES.AVATAR_TOO_SMALL)
    expect(await storedAvatarUrl(small)).toBeNull()
  })

  it('невідоме фото — 404, без сесії: сховище роздає лише те, що зберігало', async () => {
    const response = await request(app.getHttpServer())
      .get(url('/avatars/nobody/00000000-0000-0000-0000-000000000000.webp'))
      .expect(404)

    expect(errorCode(response.body)).toBe(API_ERROR_CODES.NOT_FOUND)
  })

  it('аватар більше не поле PATCH /me — 400, адреса не змінюється', async () => {
    const sneaky = await register('Хитра')

    const response = await request(app.getHttpServer())
      .patch(url('/me'))
      .set('Cookie', sneaky.cookie)
      .send({ avatarUrl: 'https://tracker.example.com/pixel.png' })
      .expect(400)

    expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    expect(await storedAvatarUrl(sneaky)).toBeNull()
  })
})
