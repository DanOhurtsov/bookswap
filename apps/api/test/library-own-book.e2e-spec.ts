import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  LIBRARY_LIMITS,
  apiErrorSchema,
  copyResponseSchema,
  ownBookResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

/**
 * `GET /me/library/copies/:copyId` — сторінка власної книги (docs/plan/own-book-page.md).
 *
 * Приватне (нотатка) віддається лише власнику; чужий і неіснуючий примірник відповідають однаково —
 * 404, а гість отримує 401 від `SessionGuard`.
 */
describe('Сторінка власної книги (e2e)', () => {
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

  interface Account {
    id: string
    cookie: string
  }

  let sequence = 0

  function marker(): string {
    sequence += 1

    return `власнакнига${String(process.pid)}${String(sequence)}`
  }

  async function register(): Promise<Account> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({
        email: uniqueEmail('own-book'),
        password: VALID_PASSWORD,
        displayName: `Читач ${marker()}`,
      })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  async function befriend(one: Account, other: Account): Promise<void> {
    await request(app.getHttpServer())
      .post(url('/friends/requests'))
      .set('Cookie', one.cookie)
      .send({ userId: other.id })
      .expect(201)
    await request(app.getHttpServer())
      .post(url('/friends/requests'))
      .set('Cookie', other.cookie)
      .send({ userId: one.id })
      .expect(201)
  }

  /** Work → Edition через справжній API (автор зберігається разом із твором). */
  async function createEdition(account: Account): Promise<{ editionId: string; title: string }> {
    const token = marker()
    const title = `Твір ${token}`

    const workResponse = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', account.cookie)
      .send({ title, origLang: 'en', authors: [{ name: `Автор ${token}` }] })
      .expect(201)

    const workId = (workResponse.body as { work: { id: string } }).work.id

    const editionResponse = await request(app.getHttpServer())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', account.cookie)
      .send({ translationId: null, publisher: 'Видавництво' })
      .expect(201)

    return {
      editionId: (editionResponse.body as { edition: { id: string } }).edition.id,
      title,
    }
  }

  async function addCopy(
    account: Account,
    editionId: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', account.cookie)
      .send({ editionId, ...body })
      .expect(201)

    return copyResponseSchema.parse(response.body).copy.id
  }

  const getOwn = (account: Account, copyId: string): request.Test =>
    request(app.getHttpServer())
      .get(url(`/me/library/copies/${copyId}`))
      .set('Cookie', account.cookie)

  describe('доступ', () => {
    it('без кукі — 401 UNAUTHORIZED', async () => {
      const response = await request(app.getHttpServer())
        .get(url('/me/library/copies/whoever'))
        .expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })

    it('чужий примірник — 404 NOT_FOUND, а не 403', async () => {
      const owner = await register()
      const stranger = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'тільки моє' })

      const response = await getOwn(stranger, copyId).expect(404)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
      expect(JSON.stringify(response.body)).not.toContain('тільки моє')
    })

    it('неіснуючий примірник — 404 тим самим кодом, що й чужий', async () => {
      const account = await register()

      const response = await getOwn(account, 'примірника-немає').expect(404)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })

    it('не затуляє статичні маршрути з одним сегментом після me/library', async () => {
      const account = await register()

      await request(app.getHttpServer())
        .get(url('/me/library/add-search?q=шантарам'))
        .set('Cookie', account.cookie)
        .expect(200)
    })
  })

  describe('відповідь власнику', () => {
    it('віддає нотатку й каталожний контекст саме цього примірника', async () => {
      const owner = await register()
      const { editionId, title } = await createEdition(owner)
      await addCopy(owner, editionId, { note: 'перший' })
      const copyId = await addCopy(owner, editionId, {
        note: 'обіцяла до Різдва',
        condition: 'WORN',
      })

      const response = await getOwn(owner, copyId).expect(200)
      const body = ownBookResponseSchema.parse(response.body)

      expect(body.copy.id).toBe(copyId)
      expect(body.copy.note).toBe('обіцяла до Різдва')
      expect(body.copy.condition).toBe('WORN')
      expect(body.edition.id).toBe(editionId)
      expect(body.work.title).toBe(title)
      expect(body.authors).toHaveLength(1)
    })

    it('віддає архівний примірник: власник відкриває його й керує ним', async () => {
      const owner = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'у коробці' })

      await request(app.getHttpServer())
        .post(url(`/me/library/${copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const body = ownBookResponseSchema.parse((await getOwn(owner, copyId).expect(200)).body)

      expect(body.copy.note).toBe('у коробці')
    })

    it('віддає примірник, що зараз у друга, разом із тримачем', async () => {
      const owner = await register()
      const friend = await register()
      await befriend(owner, friend)
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId)

      await prisma.copy.update({
        where: { id: copyId },
        data: { currentHolderId: friend.id, status: 'LENT_OUT' },
      })

      const body = ownBookResponseSchema.parse((await getOwn(owner, copyId).expect(200)).body)

      expect(body.copy.isHome).toBe(false)
      expect(body.copy.holder?.id).toBe(friend.id)
    })
  })

  describe('приватність нотатки', () => {
    it('друг, якому книжка видна на полиці, нотатки не отримує', async () => {
      const owner = await register()
      const friend = await register()
      await befriend(owner, friend)
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'таємна нотатка власника' })

      const response = await request(app.getHttpServer())
        .get(url(`/users/${owner.id}/library`))
        .set('Cookie', friend.cookie)
        .expect(200)

      expect(JSON.stringify(response.body)).toContain(copyId)
      expect(JSON.stringify(response.body)).not.toContain('таємна нотатка власника')

      // Той самий друг не може відкрити й сторінку власної книги.
      await getOwn(friend, copyId).expect(404)
    })
  })

  describe('PATCH /me/library/:copyId — нотатка зі сторінки', () => {
    it('власник змінює нотатку, і GET одразу її віддає', async () => {
      const owner = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'стара' })

      await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', owner.cookie)
        .send({ note: 'нова' })
        .expect(200)

      const body = ownBookResponseSchema.parse((await getOwn(owner, copyId).expect(200)).body)

      expect(body.copy.note).toBe('нова')
    })

    it('не власник отримує 404, і нотатка не змінюється', async () => {
      const owner = await register()
      const stranger = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'моя' })

      await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', stranger.cookie)
        .send({ note: 'чужа' })
        .expect(404)

      const stored = await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })

      expect(stored.note).toBe('моя')
    })

    it('нотатка довша за ліміт — 400 VALIDATION_ERROR, нотатка не змінюється', async () => {
      const owner = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId, { note: 'ціла' })

      const response = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', owner.cookie)
        .send({ note: 'я'.repeat(LIBRARY_LIMITS.noteMax + 1) })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })).note).toBe('ціла')
    })
  })
})
