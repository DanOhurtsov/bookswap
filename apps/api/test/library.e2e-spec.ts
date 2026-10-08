import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  apiErrorSchema,
  borrowedLibraryResponseSchema,
  copyResponseSchema,
  libraryResponseSchema,
  type LibraryResponse,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

/**
 * §6.4 і §8, блок «Бібліотека».
 *
 * Лоани створюються тут напряму через Prisma, і це навмисно: API позичань — етап
 * 2, а заборона видалити примірник з активним лоаном (§5.2) мусить працювати вже
 * зараз. Інакше перша ж реалізація стейт-машини знайшла б каскадне видалення
 * історії позичань разом із примірником.
 */
describe('Бібліотека (e2e)', () => {
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

    return `бібмаркер${String(process.pid)}${String(sequence)}`
  }

  async function register(): Promise<Account> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({
        email: uniqueEmail('library'),
        password: VALID_PASSWORD,
        displayName: `Читач ${marker()}`,
      })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  /** Ланцюг §3 через справжній API: Work → Translation → Edition. */
  async function createEdition(
    account: Account,
    options: { lang?: string; origLang?: string; title?: string; publisher?: string } = {},
  ): Promise<{ editionId: string; workId: string; title: string }> {
    const token = marker()
    const title = options.title ?? `Твір ${token}`

    const workResponse = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', account.cookie)
      .send({
        title,
        origLang: options.origLang ?? 'en',
        authors: [{ name: `Автор ${token}` }],
      })
      .expect(201)

    const workId = (workResponse.body as { work: { id: string } }).work.id
    let translationId: string | null = null

    if (options.lang !== undefined) {
      const translationResponse = await request(app.getHttpServer())
        .post(url(`/works/${workId}/translations`))
        .set('Cookie', account.cookie)
        .send({ translator: `Перекладач ${token}`, lang: options.lang, sourceLang: 'en' })
        .expect(201)

      translationId = (translationResponse.body as { translation: { id: string } }).translation.id
    }

    const editionResponse = await request(app.getHttpServer())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', account.cookie)
      .send({ translationId, publisher: options.publisher ?? 'Видавництво' })
      .expect(201)

    return {
      editionId: (editionResponse.body as { edition: { id: string } }).edition.id,
      workId,
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

  async function library(account: Account, query = ''): Promise<LibraryResponse> {
    const response = await request(app.getHttpServer())
      .get(url(`/me/library${query}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return libraryResponseSchema.parse(response.body)
  }

  describe('доступ без сесії', () => {
    it.each([
      ['get', '/me/library'],
      ['get', '/me/library/out'],
      ['get', '/me/library/borrowed'],
      ['post', '/me/library'],
      ['get', '/users/whoever/library'],
    ] as const)('%s %s без кукі — 401', async (method, path) => {
      const response = await request(app.getHttpServer())[method](url(path)).send({}).expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })
  })

  describe('POST /me/library', () => {
    it('створює примірник удома: currentHolderId = ownerId (інваріант §5.3.2)', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId, { condition: 'WORN', note: 'з полиці' })

      const stored = await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })

      expect(stored.ownerId).toBe(account.id)
      expect(stored.currentHolderId).toBe(account.id)
      expect(stored.status).toBe('AVAILABLE')
      expect(stored.condition).toBe('WORN')
    })

    it('кілька примірників одного видання — кілька рядків Copy, а не quantity (§3)', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)

      const first = await addCopy(account, editionId)
      const second = await addCopy(account, editionId, { note: 'на подарунок' })
      const third = await addCopy(account, editionId)

      expect(new Set([first, second, third]).size).toBe(3)

      const groups = (await library(account)).groups.filter(
        (group) => group.edition.id === editionId,
      )

      expect(groups).toHaveLength(1)
      expect(groups[0]?.counts).toEqual({ total: 3, home: 3, out: 0 })
      // Групування не втрачає окремі примірники: нотатка другого на місці.
      expect(groups[0]?.copies.map((copy) => copy.note)).toEqual([null, 'на подарунок', null])
    })

    it('неіснуюче видання — 404', async () => {
      const account = await register()

      const response = await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', account.cookie)
        .send({ editionId: 'видання-якого-немає' })
        .expect(404)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })
  })

  describe('GET /me/library — фільтри (§8)', () => {
    it('фільтрує за статусом', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId)

      await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .send({ status: 'UNAVAILABLE' })
        .expect(200)

      const available = await library(account, '?status=AVAILABLE')
      const unavailable = await library(account, '?status=UNAVAILABLE')

      expect(available.groups).toEqual([])
      expect(unavailable.groups[0]?.copies[0]?.id).toBe(copyId)
    })

    it('фільтрує за мовою видання — перекладу або оригіналу', async () => {
      const account = await register()
      const translated = await createEdition(account, { lang: 'uk', origLang: 'en' })
      const original = await createEdition(account, { origLang: 'pl' })

      await addCopy(account, translated.editionId)
      await addCopy(account, original.editionId)

      const uk = await library(account, '?lang=uk')
      const pl = await library(account, '?lang=pl')

      expect(uk.groups.map((group) => group.edition.id)).toEqual([translated.editionId])
      expect(pl.groups.map((group) => group.edition.id)).toEqual([original.editionId])
    })

    it('фільтрує за текстом — і за назвою, і за автором, з тією ж нормалізацією', async () => {
      const account = await register()
      const token = marker()
      const edition = await createEdition(account, { title: `Кароліна ${token}` })

      await addCopy(account, edition.editionId)

      // Верхній регістр: фільтр нормалізується так само, як titleNorm.
      const byTitle = await library(account, `?q=${encodeURIComponent(`КАРОЛІНА ${token}`)}`)
      const byNothing = await library(account, `?q=${encodeURIComponent('нічогонемає')}`)

      expect(byTitle.groups.map((group) => group.edition.id)).toEqual([edition.editionId])
      expect(byNothing.groups).toEqual([])
    })

    it('невідомий статус або мова — 400', async () => {
      const account = await register()

      await request(app.getHttpServer())
        .get(url('/me/library?status=MISSING'))
        .set('Cookie', account.cookie)
        .expect(400)
      await request(app.getHttpServer())
        .get(url('/me/library?lang=zz'))
        .set('Cookie', account.cookie)
        .expect(400)
    })
  })

  describe('PATCH /me/library/:copyId', () => {
    it('міняє метадані примірника', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId)

      const response = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .send({
          note: 'кавова пляма',
          condition: 'DAMAGED',
          visibility: 'PRIVATE',
          acquiredAt: '2026-03-01',
        })
        .expect(200)

      const { copy } = copyResponseSchema.parse(response.body)

      expect(copy.note).toBe('кавова пляма')
      expect(copy.condition).toBe('DAMAGED')
      expect(copy.visibility).toBe('PRIVATE')
      expect(copy.acquiredAt).toBe('2026-03-01')
    })

    it('перемикає AVAILABLE ↔ UNAVAILABLE — це вісь власника (§4.5)', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId)

      const off = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .send({ status: 'UNAVAILABLE' })
        .expect(200)

      expect(copyResponseSchema.parse(off.body).copy.status).toBe('UNAVAILABLE')

      const on = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .send({ status: 'AVAILABLE' })
        .expect(200)

      expect(copyResponseSchema.parse(on.body).copy.status).toBe('AVAILABLE')
    })

    it.each(['RESERVED', 'LENT_OUT'] as const)(
      'status=%s — 400: цим станом керує лише стейт-машина §5',
      async (status) => {
        const account = await register()
        const { editionId } = await createEdition(account)
        const copyId = await addCopy(account, editionId)

        const response = await request(app.getHttpServer())
          .patch(url(`/me/library/${copyId}`))
          .set('Cookie', account.cookie)
          .send({ status })
          .expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      },
    )

    it('з активним лоаном: status — 409, а нотатка й видимість проходять', async () => {
      const owner = await register()
      const borrower = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId)

      await prisma.loan.create({
        data: { copyId, ownerId: owner.id, borrowerId: borrower.id, status: 'APPROVED' },
      })

      const locked = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', owner.cookie)
        .send({ status: 'UNAVAILABLE' })
        .expect(409)

      expect(apiErrorSchema.parse(locked.body).code).toBe(API_ERROR_CODES.COPY_STATUS_LOCKED)

      // Нотатка потрібна власнику саме тоді, коли книжка в когось.
      const allowed = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', owner.cookie)
        .send({ note: 'обіцяла до Різдва', visibility: 'PRIVATE' })
        .expect(200)

      const { copy } = copyResponseSchema.parse(allowed.body)

      expect(copy.note).toBe('обіцяла до Різдва')
      expect(copy.visibility).toBe('PRIVATE')
    })

    it('порожнє тіло — 400', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId)

      const response = await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .send({})
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('чужий примірник — 404, а не 403: у моїй бібліотеці його немає', async () => {
      const owner = await register()
      const stranger = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId)

      await request(app.getHttpServer())
        .patch(url(`/me/library/${copyId}`))
        .set('Cookie', stranger.cookie)
        .send({ note: 'моє тепер' })
        .expect(404)

      const stored = await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })

      expect(stored.note).toBeNull()
    })
  })

  describe('DELETE /me/library/:copyId', () => {
    it('видаляє вільний примірник', async () => {
      const account = await register()
      const { editionId } = await createEdition(account)
      const copyId = await addCopy(account, editionId)

      await request(app.getHttpServer())
        .delete(url(`/me/library/${copyId}`))
        .set('Cookie', account.cookie)
        .expect(204)

      expect(await prisma.copy.findUnique({ where: { id: copyId } })).toBeNull()
    })

    it.each(['APPROVED', 'HANDED_OVER'] as const)(
      'не видаляє примірник із лоаном у %s (§5.2, Stage 10: COPY_HAS_LOAN_HISTORY)',
      async (status) => {
        const owner = await register()
        const borrower = await register()
        const { editionId } = await createEdition(owner)
        const copyId = await addCopy(owner, editionId)

        await prisma.loan.create({
          data: { copyId, ownerId: owner.id, borrowerId: borrower.id, status },
        })

        const response = await request(app.getHttpServer())
          .delete(url(`/me/library/${copyId}`))
          .set('Cookie', owner.cookie)
          .expect(409)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.COPY_HAS_LOAN_HISTORY)

        // Головне: історія позичань уціліла.
        expect(await prisma.copy.findUnique({ where: { id: copyId } })).not.toBeNull()
        expect(await prisma.loan.count({ where: { copyId } })).toBe(1)
      },
    )

    it('Stage 10: навіть завершений лоан блокує видалення — історія не стирається', async () => {
      const owner = await register()
      const borrower = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId)

      await prisma.loan.create({
        data: { copyId, ownerId: owner.id, borrowerId: borrower.id, status: 'RETURNED' },
      })

      const response = await request(app.getHttpServer())
        .delete(url(`/me/library/${copyId}`))
        .set('Cookie', owner.cookie)
        .expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.COPY_HAS_LOAN_HISTORY)
      expect(await prisma.loan.count({ where: { copyId } })).toBe(1)
    })

    it('чужий примірник — 404 і не видаляється', async () => {
      const owner = await register()
      const stranger = await register()
      const { editionId } = await createEdition(owner)
      const copyId = await addCopy(owner, editionId)

      await request(app.getHttpServer())
        .delete(url(`/me/library/${copyId}`))
        .set('Cookie', stranger.cookie)
        .expect(404)

      expect(await prisma.copy.findUnique({ where: { id: copyId } })).not.toBeNull()
    })
  })

  describe('в’ю «не вдома» і «чужі в мене» (§6.4)', () => {
    it('розкладає примірники за тримачем', async () => {
      const owner = await register()
      const holder = await register()
      const { editionId } = await createEdition(owner)
      const home = await addCopy(owner, editionId)
      const away = await addCopy(owner, editionId)

      // Позичань ще немає (етап 2), тож тримача проставляємо напряму — саме
      // цей стан і описують обидва в'ю.
      await prisma.copy.update({
        where: { id: away },
        data: { currentHolderId: holder.id, status: 'LENT_OUT' },
      })

      const out = libraryResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .get(url('/me/library/out'))
            .set('Cookie', owner.cookie)
            .expect(200)
        ).body,
      )

      expect(out.groups[0]?.copies.map((copy) => copy.id)).toEqual([away])
      expect(out.groups[0]?.copies[0]?.holder?.id).toBe(holder.id)

      const borrowed = borrowedLibraryResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .get(url('/me/library/borrowed'))
            .set('Cookie', holder.cookie)
            .expect(200)
        ).body,
      )

      expect(borrowed.groups[0]?.copies.map((copy) => copy.id)).toEqual([away])
      // Власника видно — інакше незрозуміло, кому повертати.
      expect(borrowed.groups[0]?.copies[0]?.owner.id).toBe(owner.id)
      // А його нотаток — ні: книжка в мене, це не доступ до його записів.
      expect(JSON.stringify(borrowed.groups[0]?.copies)).not.toContain('note')

      // Домашній примірник не потрапляє в жодне з двох в'ю.
      const stillHome = await library(owner)

      expect(stillHome.groups[0]?.copies.map((copy) => copy.id)).toContain(home)
    })
  })
})
