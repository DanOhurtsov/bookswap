import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  catalogDiscoveryResponseSchema,
  visibleLibraryResponseSchema,
  workHoldersResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import {
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'

/**
 * BS-148: «Бібліотека для друзів друзів» (functional spec §7, PROF-08, LOAN-01) — end to end.
 *
 * A friend of a friend is someone with a mutual ACCEPTED friend, and the role exists only while the
 * owner keeps the switch on. They see the library and visible copies and borrow like a friend; the
 * copy history is closed to them (403, like a stranger); a block outranks everything.
 */
describe('Друзі друзів (e2e, BS-148)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  const http = () => app.getHttpServer()

  /** Owner — mutual friend — viewer: the viewer and the owner are not friends themselves. */
  async function chain(): Promise<{ owner: Account; mutual: Account; viewer: Account }> {
    const owner = await registerAccount(app, 'fof-owner')
    const mutual = await registerAccount(app, 'fof-mutual')
    const viewer = await registerAccount(app, 'fof-viewer')

    await befriend(app, owner, mutual)
    await befriend(app, mutual, viewer)

    return { owner, mutual, viewer }
  }

  async function openToFriendsOfFriends(owner: Account, open = true): Promise<void> {
    await request(http())
      .patch(url('/me'))
      .set('Cookie', owner.cookie)
      .send({ friendsOfFriendsAccess: open })
      .expect(200)
  }

  function library(viewer: Account, owner: Account): request.Test {
    return request(http())
      .get(url(`/users/${owner.id}/library`))
      .set('Cookie', viewer.cookie)
  }

  function errorCode(response: request.Response): string {
    return apiErrorSchema.parse(response.body).code
  }

  it('без прапорця власника друг друга — сторонній: бібліотека FRIENDS закрита, просити не можна', async () => {
    const { owner, viewer } = await chain()
    const shelf = await createShelfCopy(app, owner)

    expect(errorCode(await library(viewer, owner).expect(403))).toBe(API_ERROR_CODES.FORBIDDEN)
    expect(errorCode(await requestLoan(app, viewer, shelf.copyId).expect(403))).toBe(
      API_ERROR_CODES.FORBIDDEN,
    )
  })

  it('з прапорцем бачить FRIENDS-примірники (без PRIVATE і без імен тримачів) і може просити', async () => {
    const { owner, viewer } = await chain()
    const shared = await createShelfCopy(app, owner, 'FRIENDS')
    const hidden = await createShelfCopy(app, owner, 'PRIVATE')

    await openToFriendsOfFriends(owner)

    const response = visibleLibraryResponseSchema.parse(
      (await library(viewer, owner).expect(200)).body,
    )
    const copies = response.groups.flatMap((group) => group.copies)
    const copyIds = copies.map((copy) => copy.id)

    expect(copyIds).toContain(shared.copyId)
    expect(copyIds).not.toContain(hidden.copyId)
    expect(copies.find((copy) => copy.id === shared.copyId)?.canRequest).toBe(true)

    await requestLoan(app, viewer, shared.copyId).expect(201)
  })

  it('історія примірника другові друга закрита — 403, як сторонньому', async () => {
    const { owner, viewer } = await chain()
    const shelf = await createShelfCopy(app, owner, 'PUBLIC')

    await openToFriendsOfFriends(owner)

    const response = await request(http())
      .get(url(`/copies/${shelf.copyId}/history`))
      .set('Cookie', viewer.cookie)
      .expect(403)

    expect(errorCode(response)).toBe(API_ERROR_CODES.FORBIDDEN)
  })

  it('PRIVATE-бібліотека лишається закритою й для друга друга', async () => {
    const { owner, viewer } = await chain()

    await openToFriendsOfFriends(owner)
    await request(http())
      .patch(url('/me'))
      .set('Cookie', owner.cookie)
      .send({ libraryVisibility: 'PRIVATE' })
      .expect(200)

    await library(viewer, owner).expect(403)
  })

  it('без спільного прийнятого друга прапорець нічого не дає; висячий запит у друзі — теж', async () => {
    const owner = await registerAccount(app, 'fof-owner')
    const stranger = await registerAccount(app, 'fof-stranger')
    const pendingMutual = await registerAccount(app, 'fof-pending')
    const shelf = await createShelfCopy(app, owner)

    await befriend(app, owner, pendingMutual)
    // A request the stranger sent and nobody answered: not a friendship.
    await request(http())
      .post(url('/friends/requests'))
      .set('Cookie', stranger.cookie)
      .send({ userId: pendingMutual.id })
      .expect(201)
    await openToFriendsOfFriends(owner)

    await library(stranger, owner).expect(403)
    await requestLoan(app, stranger, shelf.copyId).expect(403)
  })

  it('блок у будь-який бік перекриває доступ друга друга', async () => {
    for (const blocker of ['owner', 'viewer'] as const) {
      const { owner, viewer } = await chain()
      const shelf = await createShelfCopy(app, owner)

      await openToFriendsOfFriends(owner)

      const [actor, target] = blocker === 'owner' ? [owner, viewer] : [viewer, owner]

      await request(http())
        .post(url(`/friends/${target.id}/block`))
        .set('Cookie', actor.cookie)
        .expect(204)

      expect(errorCode(await library(viewer, owner).expect(403))).toBe(
        API_ERROR_CODES.FRIENDSHIP_BLOCKED,
      )
      expect(errorCode(await requestLoan(app, viewer, shelf.copyId).expect(403))).toBe(
        API_ERROR_CODES.FRIENDSHIP_BLOCKED,
      )
    }
  })

  it('вимкнений знову прапорець одразу закриває бібліотеку', async () => {
    const { owner, viewer } = await chain()
    const shelf = await createShelfCopy(app, owner)

    await openToFriendsOfFriends(owner)
    await library(viewer, owner).expect(200)
    await openToFriendsOfFriends(owner, false)

    await library(viewer, owner).expect(403)
    await requestLoan(app, viewer, shelf.copyId).expect(403)
  })

  describe('каталог', () => {
    async function titleOf(shelf: Shelf): Promise<string> {
      const work = await prisma.work.findUniqueOrThrow({ where: { id: shelf.workId } })

      return work.title
    }

    async function discoverAll(viewer: Account, query: string) {
      const response = await request(http())
        .get(url(`/catalog/discover?scope=ALL&q=${encodeURIComponent(query)}`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      return catalogDiscoveryResponseSchema.parse(response.body)
    }

    it('«Усі користувачі» показує FRIENDS-примірник другові друга, як на сторінці бібліотеки', async () => {
      const { owner, viewer } = await chain()
      const shelf = await createShelfCopy(app, owner, 'FRIENDS')
      const title = await titleOf(shelf)

      const closed = await discoverAll(viewer, title)

      expect(closed.results.map((result) => result.work.id)).not.toContain(shelf.workId)

      await openToFriendsOfFriends(owner)

      const opened = await discoverAll(viewer, title)
      const location = opened.results
        .find((result) => result.work.id === shelf.workId)
        ?.locations.find((candidate) => candidate.owner.id === owner.id)

      // Not a friend: no «friends» counts, no friends-first ranking — but the request button works.
      expect(location?.relation).toBe('OTHER')
      expect(location?.copies.map((copy) => [copy.id, copy.canRequest])).toEqual([
        [shelf.copyId, true],
      ])
    })

    it('«У кого є» лишається списком друзів — друга друга там немає', async () => {
      const { owner, mutual, viewer } = await chain()
      const shelf = await createShelfCopy(app, owner, 'FRIENDS')

      await openToFriendsOfFriends(owner)

      const asViewer = workHoldersResponseSchema.parse(
        (
          await request(http())
            .get(url(`/works/${shelf.workId}/holders`))
            .set('Cookie', viewer.cookie)
            .expect(200)
        ).body,
      )
      const asFriend = workHoldersResponseSchema.parse(
        (
          await request(http())
            .get(url(`/works/${shelf.workId}/holders`))
            .set('Cookie', mutual.cookie)
            .expect(200)
        ).body,
      )
      const ownersOf = (groups: typeof asViewer.groups): string[] =>
        groups.flatMap((group) => group.owners.map((entry) => entry.owner.id))

      expect(ownersOf(asViewer.groups)).not.toContain(owner.id)
      expect(ownersOf(asFriend.groups)).toContain(owner.id)
    })
  })
})
