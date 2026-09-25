import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import { PrismaService } from '../src/prisma/prisma.service'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import { createTestApp } from './auth.helpers'
import { befriend, registerAccount, url, type Account } from './loan.helpers'

/**
 * Етап 9, §2 і §10: події мережі. Перевіряється не лише що вони пишуться, а й що
 * в `ProductEvent` немає нічого приватного: ні запиту, ні назв, ні id книжок,
 * ні токена запрошення.
 */
describe('Network analytics events (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const http = (): App => app.getHttpServer()
  const tag = `аналітика${String(process.pid)}${String(Date.now())}`
  let counter = 0

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  const eventsOf = (userId: string, type: string) =>
    prisma.productEvent.findMany({ where: { subjectUserId: userId, type } })

  async function shelve(owner: Account, visibility: 'PRIVATE' | 'FRIENDS' | 'PUBLIC' = 'FRIENDS') {
    counter += 1

    const work = await request(http())
      .post(url('/works'))
      .set('Cookie', owner.cookie)
      .send({
        title: `${tag} книга ${String(counter)}`,
        origLang: 'en',
        authors: [{ name: `Автор ${tag}` }],
      })
      .expect(201)
    const workId = (work.body as { work: { id: string } }).work.id
    const edition = await request(http())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', owner.cookie)
      .send({ publisher: 'Видавництво' })
      .expect(201)
    const editionId = (edition.body as { edition: { id: string } }).edition.id
    const copy = await request(http())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId, visibility })
      .expect(201)

    return { workId, copyId: (copy.body as { copy: { id: string } }).copy.id }
  }

  describe('invite_sent / invite_accepted', () => {
    it('посилання: INVITE_SENT на створення, INVITE_ACCEPTED (запрошувачу) на прийняття, без дублів', async () => {
      const inviter = await registerAccount(app, 'an-inviter')
      const invitee = await registerAccount(app, 'an-invitee')
      const created = await request(http())
        .post(url('/invitations'))
        .set('Cookie', inviter.cookie)
        .send({ kind: 'LINK' })
        .expect(201)
      const { token } = created.body as { token: string }

      expect(await eventsOf(inviter.id, 'INVITE_SENT')).toHaveLength(1)
      expect(await eventsOf(inviter.id, 'INVITE_ACCEPTED')).toHaveLength(0)

      const accept = () =>
        request(http())
          .post(url('/invitations/accept'))
          .set('Cookie', invitee.cookie)
          .send({ token })
          .expect(200)

      await accept()
      await accept()

      expect(await eventsOf(inviter.id, 'INVITE_ACCEPTED')).toHaveLength(1)
      expect(await eventsOf(invitee.id, 'INVITE_ACCEPTED')).toHaveLength(0)
      expect(await eventsOf(inviter.id, 'FRIEND_ACCEPTED')).toHaveLength(1)
      expect(await eventsOf(invitee.id, 'FRIEND_ACCEPTED')).toHaveLength(1)
    })

    it('невдале прийняття (прострочене, блок) подій не пише', async () => {
      const inviter = await registerAccount(app, 'an-inviter2')
      const late = await registerAccount(app, 'an-late')
      const created = await request(http())
        .post(url('/invitations'))
        .set('Cookie', inviter.cookie)
        .send({ kind: 'LINK' })
        .expect(201)
      const { token, invitation } = created.body as { token: string; invitation: { id: string } }

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      await request(http())
        .post(url('/invitations/accept'))
        .set('Cookie', late.cookie)
        .send({ token })
        .expect(410)

      expect(await eventsOf(inviter.id, 'INVITE_ACCEPTED')).toHaveLength(0)
      expect(await eventsOf(late.id, 'FRIEND_ACCEPTED')).toHaveLength(0)
    })

    it('у подіях немає токена, адреси чи id запрошення в сирому вигляді', async () => {
      const inviter = await registerAccount(app, 'an-inviter3')
      const invitee = await registerAccount(app, 'an-invitee3')
      const created = await request(http())
        .post(url('/invitations'))
        .set('Cookie', inviter.cookie)
        .send({ kind: 'LINK' })
        .expect(201)
      const { token, invitation } = created.body as { token: string; invitation: { id: string } }

      await request(http())
        .post(url('/invitations/accept'))
        .set('Cookie', invitee.cookie)
        .send({ token })
        .expect(200)

      const rows = await prisma.productEvent.findMany({
        where: { subjectUserId: { in: [inviter.id, invitee.id] } },
      })
      const raw = JSON.stringify(rows)

      expect(raw).not.toContain(token)
      expect(raw).not.toContain(invitation.id)

      for (const row of rows) expect(row.properties).toEqual({})
    })
  })

  describe('friend_inventory_became_usable', () => {
    it('дружба з другом, що має видиму доступну книжку → подія рівно раз для того, хто побачив', async () => {
      const viewer = await registerAccount(app, 'an-usable-viewer')
      const owner = await registerAccount(app, 'an-usable-owner')

      await shelve(owner, 'FRIENDS')
      await befriend(app, viewer, owner)

      expect(await eventsOf(viewer.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(1)

      // Власник теж отримав друга, але в нього немає книг друга — події немає.
      expect(await eventsOf(owner.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(0)

      await shelve(owner, 'FRIENDS')
      expect(await eventsOf(viewer.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(1)
    })

    it('лише PRIVATE книжки або закрита бібліотека — події немає, відкриття → є', async () => {
      const viewer = await registerAccount(app, 'an-priv-viewer')
      const owner = await registerAccount(app, 'an-priv-owner')

      await shelve(owner, 'PRIVATE')
      await befriend(app, viewer, owner)

      expect(await eventsOf(viewer.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(0)

      await shelve(owner, 'FRIENDS')

      expect(await eventsOf(viewer.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(1)
    })

    it('бібліотека друга PRIVATE ховає навіть FRIENDS-книжки', async () => {
      const viewer = await registerAccount(app, 'an-lib-viewer')
      const owner = await registerAccount(app, 'an-lib-owner')

      await prisma.user.update({ where: { id: owner.id }, data: { libraryVisibility: 'PRIVATE' } })
      await shelve(owner, 'FRIENDS')
      await befriend(app, viewer, owner)

      expect(await eventsOf(viewer.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(0)
    })

    it('прийняття запрошення теж запускає перевірку', async () => {
      const inviter = await registerAccount(app, 'an-usable-inviter')
      const invitee = await registerAccount(app, 'an-usable-invitee')

      await shelve(inviter, 'FRIENDS')

      const created = await request(http())
        .post(url('/invitations'))
        .set('Cookie', inviter.cookie)
        .send({ kind: 'LINK' })
        .expect(201)

      await request(http())
        .post(url('/invitations/accept'))
        .set('Cookie', invitee.cookie)
        .send({ token: (created.body as { token: string }).token })
        .expect(200)

      expect(await eventsOf(invitee.id, 'FRIEND_INVENTORY_USABLE')).toHaveLength(1)
    })
  })

  describe('discovery_searched / friend_book_found / work_holders_found', () => {
    it('текстовий пошук у колі: SEARCHED раз на добу, FOUND лише коли в друга є що просити', async () => {
      const viewer = await registerAccount(app, 'an-search-viewer')
      const friend = await registerAccount(app, 'an-search-friend')

      await befriend(app, viewer, friend)

      const empty = await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(`${tag} нічого немає`)}`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect((empty.body as { results: unknown[] }).results).toHaveLength(0)
      expect(await eventsOf(viewer.id, 'DISCOVERY_SEARCHED')).toHaveLength(1)
      expect(await eventsOf(viewer.id, 'FRIEND_BOOK_FOUND')).toHaveLength(0)

      await shelve(friend)
      await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(tag)}`))
        .set('Cookie', viewer.cookie)
        .expect(200)
      await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(tag)}&page=1`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(await eventsOf(viewer.id, 'DISCOVERY_SEARCHED')).toHaveLength(1)
      expect(await eventsOf(viewer.id, 'FRIEND_BOOK_FOUND')).toHaveLength(1)
    })

    it('перегляд без тексту, режим ALL і власна книжка подій не дають', async () => {
      const viewer = await registerAccount(app, 'an-quiet-viewer')
      const stranger = await registerAccount(app, 'an-quiet-stranger')

      await prisma.user.update({
        where: { id: stranger.id },
        data: { libraryVisibility: 'PUBLIC' },
      })
      await shelve(viewer)
      await shelve(stranger, 'PUBLIC')

      await request(http()).get(url('/catalog/discover')).set('Cookie', viewer.cookie).expect(200)
      await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(tag)}&scope=ALL`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(await eventsOf(viewer.id, 'DISCOVERY_SEARCHED')).toHaveLength(0)

      await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(tag)}`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      // Знайшлася лише власна книжка — це не «знайшов у друзів».
      expect(await eventsOf(viewer.id, 'DISCOVERY_SEARCHED')).toHaveLength(1)
      expect(await eventsOf(viewer.id, 'FRIEND_BOOK_FOUND')).toHaveLength(0)
    })

    it('Who has this: WORK_HOLDERS_FOUND лише коли друг має доступний примірник', async () => {
      const viewer = await registerAccount(app, 'an-holders-viewer')
      const friend = await registerAccount(app, 'an-holders-friend')

      await befriend(app, viewer, friend)

      const shelf = await shelve(friend)

      await prisma.copy.update({ where: { id: shelf.copyId }, data: { status: 'UNAVAILABLE' } })
      await request(http())
        .get(url(`/works/${shelf.workId}/holders`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(await eventsOf(viewer.id, 'WORK_HOLDERS_FOUND')).toHaveLength(0)

      await prisma.copy.update({ where: { id: shelf.copyId }, data: { status: 'AVAILABLE' } })
      await request(http())
        .get(url(`/works/${shelf.workId}/holders`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(await eventsOf(viewer.id, 'WORK_HOLDERS_FOUND')).toHaveLength(1)
    })

    it('в подіях немає тексту запиту, назв, id твору чи примірника; ключ — доба', async () => {
      const viewer = await registerAccount(app, 'an-priv2-viewer')
      const friend = await registerAccount(app, 'an-priv2-friend')

      await befriend(app, viewer, friend)

      const shelf = await shelve(friend)
      const query = `${tag} книга`

      await request(http())
        .get(url(`/catalog/discover?q=${encodeURIComponent(query)}&language=en`))
        .set('Cookie', viewer.cookie)
        .expect(200)
      await request(http())
        .get(url(`/works/${shelf.workId}/holders`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      const rows = await prisma.productEvent.findMany({ where: { subjectUserId: viewer.id } })
      const raw = JSON.stringify(rows)

      expect(raw).not.toContain(tag)
      expect(raw).not.toContain(shelf.workId)
      expect(raw).not.toContain(shelf.copyId)
      expect(raw).not.toContain(friend.id)

      for (const row of rows) expect(row.properties).toEqual({})

      const day = new Date().toISOString().slice(0, 10)

      expect(rows.map((row) => row.dedupeKey)).toContain(
        computeDedupeKey('DISCOVERY_SEARCHED', day, viewer.id),
      )
    })
  })
})
