import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_PREFIX,
  catalogDiscoveryResponseSchema,
  type CatalogDiscoveryResponse,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

type Account = { id: string; cookie: string }

describe('Catalog discovery (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let viewer: Account

  const url = (path: string): string => `${API_PREFIX}${path}`

  async function register(name: string): Promise<Account> {
    const response = await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email: uniqueEmail('discovery'), password: VALID_PASSWORD, displayName: name })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  async function book(owner: Account, title: string, visibility: 'PUBLIC' | 'FRIENDS' | 'PRIVATE') {
    const work = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', owner.cookie)
      .send({ title, origLang: 'uk', authors: [{ name: 'Тестовий автор' }] })
      .expect(201)
    const workId = (work.body as { work: { id: string } }).work.id
    const edition = await request(app.getHttpServer())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', owner.cookie)
      .send({ translationId: null, publisher: 'Тестове видавництво' })
      .expect(201)
    const editionId = (edition.body as { edition: { id: string } }).edition.id
    const copy = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId, visibility })
      .expect(201)

    return { workId, copyId: (copy.body as { copy: { id: string } }).copy.id }
  }

  async function find(
    query: string,
    suffix = '',
    cookie = viewer.cookie,
  ): Promise<CatalogDiscoveryResponse> {
    const response = await request(app.getHttpServer())
      .get(url(`/catalog/discover?q=${encodeURIComponent(query)}${suffix}`))
      .set('Cookie', cookie)
      .expect(200)

    return catalogDiscoveryResponseSchema.parse(response.body)
  }

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    viewer = await register('Пошукач')
  })

  afterAll(async () => {
    await app.close()
  })

  it('requires a session and validates the scope', async () => {
    await request(app.getHttpServer()).get(url('/catalog/discover?q=книжка')).expect(401)
    await request(app.getHttpServer())
      .get(url('/catalog/discover?q=книжка&scope=SECRET'))
      .set('Cookie', viewer.cookie)
      .expect(400)
  })

  it('shows available own and friend copies by default; ALL adds visible public users', async () => {
    const token = `пошукполиця${String(process.pid)}${String(Date.now())}`
    const friend = await register('Подруга')
    const stranger = await register('Публічний читач')
    const blocked = await register('Заблокований читач')

    const own = await book(viewer, `${token} своя`, 'PRIVATE')
    const friendBook = await book(friend, `${token} друга`, 'FRIENDS')
    const strangerBook = await book(stranger, `${token} публічна`, 'PUBLIC')
    const hidden = await book(stranger, `${token} приватна`, 'PRIVATE')
    const blockedBook = await book(blocked, `${token} заблокована`, 'PUBLIC')
    const unavailable = await book(friend, `${token} зайнята`, 'FRIENDS')
    const noCopy = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', viewer.cookie)
      .send({
        title: `${token} без примірника`,
        origLang: 'uk',
        authors: [{ name: 'Тестовий автор' }],
      })
      .expect(201)

    await prisma.user.update({ where: { id: stranger.id }, data: { libraryVisibility: 'PUBLIC' } })
    await prisma.user.update({ where: { id: blocked.id }, data: { libraryVisibility: 'PUBLIC' } })
    await prisma.copy.update({ where: { id: unavailable.copyId }, data: { status: 'UNAVAILABLE' } })

    await request(app.getHttpServer())
      .post(url('/friends/requests'))
      .set('Cookie', viewer.cookie)
      .send({ userId: friend.id })
      .expect(201)
    const incoming = await request(app.getHttpServer())
      .get(url('/friends/requests'))
      .set('Cookie', friend.cookie)
      .expect(200)
    const requestId = (incoming.body as { incoming: { id: string }[] }).incoming[0]?.id
    await request(app.getHttpServer())
      .patch(url(`/friends/requests/${requestId}`))
      .set('Cookie', friend.cookie)
      .send({ action: 'accept' })
      .expect(200)
    await request(app.getHttpServer())
      .post(url(`/friends/${blocked.id}/block`))
      .set('Cookie', viewer.cookie)
      .expect(204)

    const circle = await find(token)
    expect(circle.scope).toBe('CIRCLE')
    expect(circle.results.map((result) => result.work.id)).toEqual(
      expect.arrayContaining([own.workId, friendBook.workId]),
    )
    expect(circle.results).toHaveLength(2)

    const all = await find(token, '&scope=ALL')
    expect(all.results.map((result) => result.work.id)).toEqual(
      expect.arrayContaining([own.workId, friendBook.workId, strangerBook.workId]),
    )
    const foundIds = all.results.map((result) => result.work.id)

    for (const forbiddenId of [
      hidden.workId,
      blockedBook.workId,
      unavailable.workId,
      (noCopy.body as { work: { id: string } }).work.id,
    ]) {
      expect(foundIds).not.toContain(forbiddenId)
    }
    expect(
      all.results.find((result) => result.work.id === strangerBook.workId)?.locations[0]?.relation,
    ).toBe('OTHER')
    expect(
      all.results.find((result) => result.work.id === own.workId)?.locations[0]?.relation,
    ).toBe('SELF')
  })

  it('matches an ISBN only when a copy of that exact edition is available', async () => {
    const owned = await book(viewer, `ISBN discovery ${String(Date.now())}`, 'PRIVATE')
    await request(app.getHttpServer())
      .post(url(`/works/${owned.workId}/editions`))
      .set('Cookie', viewer.cookie)
      .send({ translationId: null, isbn13: '9780306406157' })
      .expect(201)

    const result = await find('9780306406157')
    expect(result.results).toEqual([])
    expect(result.total).toBe(0)
  })
})
