import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  ACTIVATION_TARGET,
  API_ERROR_CODES,
  API_PREFIX,
  activationResponseSchema,
  apiErrorSchema,
  type ActivationResponse,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

/**
 * Stage 8h-1, R11: `GET /me/activation`.
 *
 * Every test registers its own account, because the assertion is an absolute
 * count and the e2e files share one database — a shelf that started at zero is
 * the only way this file can claim anything about nine versus ten.
 *
 * Bulk copies are created through Prisma rather than through `POST /me/library`
 * for the same reason `library.e2e-spec.ts` writes loans directly: getting to
 * the tenth book is setup here, not the subject. The subject is what the count
 * endpoint says about a shelf of a given size — and the very first test still
 * walks the real add path, so the two are known to agree.
 */
describe('Activation progress (e2e)', () => {
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

    return `активмаркер${String(process.pid)}${String(sequence)}`
  }

  async function register(): Promise<Account> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({
        email: uniqueEmail('activation'),
        password: VALID_PASSWORD,
        displayName: `Власник ${marker()}`,
      })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  /** §3 chain through the real API: Work → Edition. One is enough — copies repeat. */
  async function createEdition(account: Account): Promise<string> {
    const token = marker()

    const workResponse = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', account.cookie)
      .send({ title: `Твір ${token}`, origLang: 'en', authors: [{ name: `Автор ${token}` }] })
      .expect(201)

    const workId = (workResponse.body as { work: { id: string } }).work.id

    const editionResponse = await request(app.getHttpServer())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', account.cookie)
      .send({ translationId: null, publisher: 'Видавництво' })
      .expect(201)

    return (editionResponse.body as { edition: { id: string } }).edition.id
  }

  async function addCopyViaApi(account: Account, editionId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', account.cookie)
      .send({ editionId })
      .expect(201)
  }

  async function seedCopies(ownerId: string, editionId: string, howMany: number): Promise<void> {
    if (howMany === 0) return

    await prisma.copy.createMany({
      data: Array.from({ length: howMany }, () => ({
        editionId,
        ownerId,
        currentHolderId: ownerId,
      })),
    })
  }

  async function progressOf(account: Account): Promise<ActivationResponse> {
    const response = await request(app.getHttpServer())
      .get(url('/me/activation'))
      .set('Cookie', account.cookie)
      .expect(200)

    // Parsed by the shared schema, which refuses a response whose fields
    // disagree — so every assertion below stands on a contract-valid answer.
    return activationResponseSchema.parse(response.body)
  }

  /** A shelf of exactly `howMany` books, owned by a brand-new account. */
  async function ownerWith(howMany: number): Promise<Account> {
    const account = await register()

    if (howMany > 0) {
      const editionId = await createEdition(account)

      await seedCopies(account.id, editionId, howMany)
    }

    return account
  }

  describe('пороги', () => {
    it('порожня полиця — нуль книжок і прохання додати', async () => {
      const account = await register()

      expect(await progressOf(account)).toEqual({
        ownedCopyCount: 0,
        target: ACTIVATION_TARGET,
        hasReachedTarget: false,
        nextAction: 'ADD_BOOKS',
      })
    })

    it('перша книжка, додана справжнім POST /me/library, потрапляє в прогрес', async () => {
      const account = await register()
      const editionId = await createEdition(account)

      await addCopyViaApi(account, editionId)

      expect(await progressOf(account)).toEqual({
        ownedCopyCount: 1,
        target: ACTIVATION_TARGET,
        hasReachedTarget: false,
        nextAction: 'ADD_BOOKS',
      })
    })

    it('дев’ята книжка ще не відкриває запрошення друзів', async () => {
      const account = await ownerWith(9)

      expect(await progressOf(account)).toEqual({
        ownedCopyCount: 9,
        target: ACTIVATION_TARGET,
        hasReachedTarget: false,
        nextAction: 'ADD_BOOKS',
      })
    })

    it('десята книжка перемикає наступну дію на друзів', async () => {
      const account = await ownerWith(ACTIVATION_TARGET)

      expect(await progressOf(account)).toEqual({
        ownedCopyCount: ACTIVATION_TARGET,
        target: ACTIVATION_TARGET,
        hasReachedTarget: true,
        nextAction: 'INVITE_FRIENDS',
      })
    })

    it('понад десять — лічильник росте далі, дія лишається INVITE_FRIENDS', async () => {
      const account = await ownerWith(13)

      expect(await progressOf(account)).toEqual({
        ownedCopyCount: 13,
        target: ACTIVATION_TARGET,
        hasReachedTarget: true,
        nextAction: 'INVITE_FRIENDS',
      })
    })

    it('дев’ята книжка стає десятою рівно тоді, коли її додали', async () => {
      const account = await ownerWith(9)
      const editionId = await createEdition(account)

      expect((await progressOf(account)).hasReachedTarget).toBe(false)

      await addCopyViaApi(account, editionId)

      expect(await progressOf(account)).toMatchObject({
        ownedCopyCount: ACTIVATION_TARGET,
        hasReachedTarget: true,
        nextAction: 'INVITE_FRIENDS',
      })
    })
  })

  describe('що саме рахується', () => {
    it('чужі примірники не рахуються — навіть коли вони того самого видання', async () => {
      const owner = await register()
      const stranger = await register()
      const editionId = await createEdition(owner)

      await seedCopies(stranger.id, editionId, 12)
      await seedCopies(owner.id, editionId, 2)

      expect(await progressOf(owner)).toMatchObject({
        ownedCopyCount: 2,
        hasReachedTarget: false,
        nextAction: 'ADD_BOOKS',
      })
      expect(await progressOf(stranger)).toMatchObject({
        ownedCopyCount: 12,
        hasReachedTarget: true,
        nextAction: 'INVITE_FRIENDS',
      })
    })

    it('власна книжка рахується попри status, visibility і чужого тримача', async () => {
      const owner = await ownerWith(ACTIVATION_TARGET)
      const borrower = await register()
      const copies = await prisma.copy.findMany({
        where: { ownerId: owner.id },
        select: { id: true },
        orderBy: { id: 'asc' },
      })

      expect(copies).toHaveLength(ACTIVATION_TARGET)

      // Кожен з трьох вимірів, якими примірник «зникає» з інших екранів:
      // позичений, схований і тимчасово не даний. Жоден не робить книжку
      // чужою — інакше чекліст скасовував би сам себе, щойно десяту книжку
      // хтось узяв почитати.
      await prisma.copy.update({
        where: { id: copies[0]?.id ?? '' },
        data: { status: 'LENT_OUT', currentHolderId: borrower.id },
      })
      await prisma.copy.update({
        where: { id: copies[1]?.id ?? '' },
        data: { visibility: 'PRIVATE' },
      })
      await prisma.copy.update({
        where: { id: copies[2]?.id ?? '' },
        data: { status: 'UNAVAILABLE' },
      })

      expect(await progressOf(owner)).toMatchObject({
        ownedCopyCount: ACTIVATION_TARGET,
        hasReachedTarget: true,
        nextAction: 'INVITE_FRIENDS',
      })

      // Тримач чужої книжки не стає її власником.
      expect(await progressOf(borrower)).toMatchObject({ ownedCopyCount: 0 })
    })

    it('видалений примірник зменшує прогрес — це доменний стан, не лічильник подій', async () => {
      const account = await ownerWith(ACTIVATION_TARGET)
      const copy = await prisma.copy.findFirst({
        where: { ownerId: account.id },
        select: { id: true },
      })

      await request(app.getHttpServer())
        .delete(url(`/me/library/${copy?.id ?? ''}`))
        .set('Cookie', account.cookie)
        .expect(204)

      expect(await progressOf(account)).toMatchObject({
        ownedCopyCount: ACTIVATION_TARGET - 1,
        hasReachedTarget: false,
        nextAction: 'ADD_BOOKS',
      })
    })
  })

  describe('доступ і поверхня відповіді', () => {
    it('без кукі — 401', async () => {
      const response = await request(app.getHttpServer()).get(url('/me/activation')).expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })

    it('відповідь містить рівно чотири поля — жодних каталогових чи приватних', async () => {
      const account = await register()
      const editionId = await createEdition(account)

      await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', account.cookie)
        .send({ editionId, note: 'кавова пляма на 213-й', visibility: 'PRIVATE' })
        .expect(201)

      const response = await request(app.getHttpServer())
        .get(url('/me/activation'))
        .set('Cookie', account.cookie)
        .expect(200)

      // Перевіряється ВІДСУТНІСТЬ ключів, а не їхні значення: `note: null` тут
      // теж був би витоком — він каже, що нотатки немає (той самий принцип, що
      // й у `library.mapper.spec.ts`).
      expect(Object.keys(response.body as object).sort()).toEqual([
        'hasReachedTarget',
        'nextAction',
        'ownedCopyCount',
        'target',
      ])
      expect(JSON.stringify(response.body)).not.toContain('кавова пляма')
    })
  })
})
