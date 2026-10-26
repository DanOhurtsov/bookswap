import 'reflect-metadata'
import { Client } from 'pg'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  friendsReadingResponseSchema,
  type FriendsReadingResponse,
  type ReadingStatus,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { befriend, createShelfCopy, registerAccount, url, type Account } from './loan.helpers'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * BS-137 (docs/plan/bs-137-friends-reading.md): `GET /me/friends/reading`. Every test reads the feed of
 * a viewer of its own: the e2e files share one database, and a feed is everything the viewer's friends
 * are reading.
 */
describe('BS-137: what my friends are reading (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let librarian: Account
  let sequence = 0

  const server = () => app.getHttpServer()

  const put = (account: Account, workId: string, status: ReadingStatus): request.Test =>
    request(server())
      .put(url(`/me/reading-statuses/${workId}`))
      .set('Cookie', account.cookie)
      .send({ status })

  async function feedOf(account: Account, query = ''): Promise<FriendsReadingResponse> {
    const res = await request(server())
      .get(url(`/me/friends/reading${query}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return friendsReadingResponseSchema.parse(res.body)
  }

  /** `friendId:workId` of every item, in the order of the feed. */
  async function pairsOf(account: Account, query = ''): Promise<string[]> {
    const feed = await feedOf(account, query)

    return feed.items.map((item) => `${item.friend.id}:${item.work.id}`)
  }

  /** A work with no copy at all, with an edition per entry of `covers`. */
  async function newWork(
    covers: (string | null)[] = [],
  ): Promise<{ workId: string; editionIds: string[] }> {
    sequence += 1

    const token = `${String(process.pid)}-${String(sequence)}`
    const work = await request(server())
      .post(url('/works'))
      .set('Cookie', librarian.cookie)
      .send({
        title: `Стрічка ${token}`,
        origLang: 'uk',
        authors: [{ name: `Стрічкова ${token}` }],
      })
      .expect(201)
    const workId = (work.body as { work: { id: string } }).work.id
    const editionIds: string[] = []

    for (const coverUrl of covers) {
      const edition = await request(server())
        .post(url(`/works/${workId}/editions`))
        .set('Cookie', librarian.cookie)
        .send({ publisher: 'Стрічка', year: 2020, ...(coverUrl === null ? {} : { coverUrl }) })
        .expect(201)

      editionIds.push((edition.body as { edition: { id: string } }).edition.id)
    }

    return { workId, editionIds }
  }

  /** A viewer with one accepted friend. */
  async function viewerWithFriend(prefix: string): Promise<{ viewer: Account; friend: Account }> {
    const viewer = await registerAccount(app, `${prefix}-v`)
    const friend = await registerAccount(app, `${prefix}-f`)

    await befriend(app, viewer, friend)

    return { viewer, friend }
  }

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    librarian = await registerAccount(app, 'bs137-lib')
  })

  afterAll(async () => {
    await app.close()
  })

  it('without a session it is 401 with a code', async () => {
    const res = await request(server()).get(url('/me/friends/reading')).expect(401)

    expect(apiErrorSchema.parse(res.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
  })

  it('a viewer with no friends gets hasFriends: false and nothing else', async () => {
    const viewer = await registerAccount(app, 'bs137-alone')
    const stranger = await registerAccount(app, 'bs137-alone-s')
    const { workId } = await newWork()

    await put(stranger, workId, 'READING').expect(200)

    expect(await feedOf(viewer)).toEqual({ hasFriends: false, items: [], nextCursor: null })
  })

  it('friends who read nothing right now: hasFriends: true with no items', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-idle')
    const [read, notRead] = await Promise.all([newWork(), newWork()])

    await put(friend, read.workId, 'READ').expect(200)
    await put(friend, notRead.workId, 'NOT_READ').expect(200)

    expect(await feedOf(viewer)).toEqual({ hasFriends: true, items: [], nextCursor: null })
  })

  it('only READING: NOT_READ and READ of the same friend stay out', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-only')
    const [reading, read, notRead] = await Promise.all([newWork(), newWork(), newWork()])

    await put(friend, notRead.workId, 'NOT_READ').expect(200)
    await put(friend, reading.workId, 'READING').expect(200)
    await put(friend, read.workId, 'READ').expect(200)

    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${reading.workId}`])
  })

  it('only ACCEPTED friends: pending both ways, declined, blocked both ways, removed and strangers stay out', async () => {
    const viewer = await registerAccount(app, 'bs137-acc-v')
    const register = (name: string) => registerAccount(app, `bs137-acc-${name}`)
    const people = {
      friend: await register('friend'),
      sent: await register('sent'),
      received: await register('received'),
      declined: await register('declined'),
      blocker: await register('blocker'),
      blocked: await register('blocked'),
      removed: await register('removed'),
      stranger: await register('stranger'),
    }
    const friendRequest = (from: Account, to: Account) =>
      request(server())
        .post(url('/friends/requests'))
        .set('Cookie', from.cookie)
        .send({ userId: to.id })
        .expect(201)

    await befriend(app, viewer, people.friend)
    await friendRequest(viewer, people.sent)
    await friendRequest(people.received, viewer)

    await friendRequest(people.declined, viewer)
    const incoming = await request(server())
      .get(url('/friends/requests'))
      .set('Cookie', viewer.cookie)
      .expect(200)
    const declinedId = (
      incoming.body as { incoming: { id: string; user: { id: string } }[] }
    ).incoming.find((item) => item.user.id === people.declined.id)!.id

    await request(server())
      .patch(url(`/friends/requests/${declinedId}`))
      .set('Cookie', viewer.cookie)
      .send({ action: 'decline' })
      .expect(200)

    // Blocked after a friendship, in both directions: a block ends the friendship.
    await befriend(app, viewer, people.blocker)
    await befriend(app, viewer, people.blocked)
    await request(server())
      .post(url(`/friends/${viewer.id}/block`))
      .set('Cookie', people.blocker.cookie)
      .expect(204)
    await request(server())
      .post(url(`/friends/${people.blocked.id}/block`))
      .set('Cookie', viewer.cookie)
      .expect(204)

    await befriend(app, viewer, people.removed)
    await request(server())
      .delete(url(`/friends/${people.removed.id}`))
      .set('Cookie', viewer.cookie)
      .expect(204)

    const { workId } = await newWork()

    for (const person of Object.values(people)) await put(person, workId, 'READING').expect(200)

    const feed = await feedOf(viewer)

    expect(feed.hasFriends).toBe(true)
    expect(feed.items.map((item) => item.friend.id)).toEqual([people.friend.id])
  })

  it('READING → READ takes the item away on the next GET; READ → READING brings it back', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-move')
    const { workId } = await newWork()

    await put(friend, workId, 'READING').expect(200)
    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${workId}`])

    await put(friend, workId, 'READ').expect(200)
    expect(await feedOf(viewer)).toEqual({ hasFriends: true, items: [], nextCursor: null })

    await put(friend, workId, 'READING').expect(200)
    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${workId}`])
  })

  it('one work read by several friends is one item per friend', async () => {
    const viewer = await registerAccount(app, 'bs137-same-v')
    const [one, two] = await Promise.all([
      registerAccount(app, 'bs137-same-1'),
      registerAccount(app, 'bs137-same-2'),
    ])
    const { workId } = await newWork()

    await befriend(app, viewer, one)
    await befriend(app, viewer, two)
    await put(one, workId, 'READING').expect(200)
    await put(two, workId, 'READING').expect(200)

    const feed = await feedOf(viewer)

    expect(feed.items.map((item) => `${item.friend.id}:${item.work.id}`)).toEqual([
      `${two.id}:${workId}`,
      `${one.id}:${workId}`,
    ])
    expect(feed.items[0]!.friend.displayName).toBe(two.displayName)
    expect(feed.items[1]!.friend.displayName).toBe(one.displayName)
  })

  it('orders by updatedAt DESC, then by id DESC; the cursor pages through without gaps or repeats', async () => {
    const viewer = await registerAccount(app, 'bs137-order-v')
    const [one, two] = await Promise.all([
      registerAccount(app, 'bs137-order-1'),
      registerAccount(app, 'bs137-order-2'),
    ])
    const works = await Promise.all(Array.from({ length: 5 }, () => newWork()))

    await befriend(app, viewer, one)
    await befriend(app, viewer, two)

    for (const [index, work] of works.entries()) {
      await put(index % 2 === 0 ? one : two, work.workId, 'READING').expect(200)
    }

    // Two rows on one instant: only the id tells them apart.
    const rows = await prisma.workReadingStatus.findMany({
      where: { userId: { in: [one.id, two.id] }, workId: { in: works.map((work) => work.workId) } },
      select: { id: true, userId: true, workId: true },
    })
    const tied = rows.filter(
      (row) => row.workId === works[1]!.workId || row.workId === works[2]!.workId,
    )
    const instant = new Date('2030-01-01T00:00:00.000Z')

    await prisma.workReadingStatus.updateMany({
      where: { id: { in: tied.map((row) => row.id) } },
      data: { updatedAt: instant },
    })

    const ordered = await prisma.workReadingStatus.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { userId: true, workId: true },
    })
    const expected = ordered.map((row) => `${row.userId}:${row.workId}`)

    // The two tied rows lead, the newer of the rest follow — not the order of the PUTs.
    expect(new Set(expected.slice(0, 2))).toEqual(
      new Set(tied.map((row) => `${row.userId}:${row.workId}`)),
    )
    expect(await pairsOf(viewer)).toEqual(expected)

    const first = await feedOf(viewer, '?limit=2')
    const second = await feedOf(viewer, `?limit=2&cursor=${first.nextCursor!}`)
    const third = await feedOf(viewer, `?limit=2&cursor=${second.nextCursor!}`)
    const paged = [first, second, third].flatMap((page) =>
      page.items.map((item) => `${item.friend.id}:${item.work.id}`),
    )

    expect(paged).toEqual(expected)
    expect(third.nextCursor).toBeNull()
    expect(first.hasFriends && second.hasFriends && third.hasFriends).toBe(true)
  })

  it('the first page holds 12 by default; an invalid cursor, limit or a userId is 400', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-page')
    const works = await Promise.all(Array.from({ length: 13 }, () => newWork()))

    for (const work of works) await put(friend, work.workId, 'READING').expect(200)

    const feed = await feedOf(viewer)

    expect(feed.items).toHaveLength(12)
    expect(feed.nextCursor).not.toBeNull()

    for (const query of ['?cursor=not-a-cursor', '?limit=49', '?limit=0', `?userId=${friend.id}`]) {
      const res = await request(server())
        .get(url(`/me/friends/reading${query}`))
        .set('Cookie', viewer.cookie)
        .expect(400)

      expect(apiErrorSchema.parse(res.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    }
  })

  it('the cover is the first edition with one by createdAt, then id; with none it is null', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-cover')
    const covered = await newWork([
      null,
      'https://covers.example/b.jpg',
      'https://covers.example/a.jpg',
    ])
    const tied = await newWork(['https://covers.example/x.jpg', 'https://covers.example/y.jpg'])
    const bare = await newWork([null])
    const noEdition = await newWork()

    // The edition without a cover is the oldest: it is skipped, not taken for "no cover".
    const [, b, a] = covered.editionIds
    await prisma.edition.update({
      where: { id: covered.editionIds[0]! },
      data: { createdAt: new Date('2020-01-01') },
    })
    await prisma.edition.update({ where: { id: b! }, data: { createdAt: new Date('2021-01-01') } })
    await prisma.edition.update({ where: { id: a! }, data: { createdAt: new Date('2022-01-01') } })

    // Same instant: the smaller id wins.
    await prisma.edition.updateMany({
      where: { id: { in: tied.editionIds } },
      data: { createdAt: new Date('2021-06-01') },
    })
    const [smaller] = [...tied.editionIds].sort()
    const smallerCover = (
      await prisma.edition.findUniqueOrThrow({
        where: { id: smaller! },
        select: { coverUrl: true },
      })
    ).coverUrl

    for (const work of [covered, tied, bare, noEdition])
      await put(friend, work.workId, 'READING').expect(200)

    const coverOf = new Map(
      (await feedOf(viewer)).items.map((item) => [item.work.id, item.coverUrl]),
    )

    expect(coverOf.get(covered.workId)).toBe('https://covers.example/b.jpg')
    expect(coverOf.get(tied.workId)).toBe(smallerCover)
    expect(coverOf.get(bare.workId)).toBeNull()
    expect(coverOf.get(noEdition.workId)).toBeNull()
  })

  it('does not depend on copies: a work with no copy shows, and the visibility of a copy does not matter', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-copy')
    const noCopy = await newWork()
    const privateCopy = await createShelfCopy(app, librarian, 'PRIVATE')

    await put(friend, noCopy.workId, 'READING').expect(200)
    await put(friend, privateCopy.workId, 'READING').expect(200)

    expect(new Set(await pairsOf(viewer))).toEqual(
      new Set([`${friend.id}:${noCopy.workId}`, `${friend.id}:${privateCopy.workId}`]),
    )
  })

  it('shows only canonical works: after a merge the item is the target, and a merged source never shows', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-merge')
    const [source, target, merged, canonical] = await Promise.all([
      newWork(),
      newWork(),
      newWork(),
      newWork(),
    ])

    await put(friend, source.workId, 'READING').expect(200)
    await new MergeService(prisma).merge(source.workId, target.workId)

    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${target.workId}`])

    // A row left on a merged work would break the merge invariant; the feed still must not show it.
    await prisma.work.update({
      where: { id: merged.workId },
      data: { mergedIntoId: canonical.workId },
    })
    await prisma.workReadingStatus.create({
      data: { userId: friend.id, workId: merged.workId, status: 'READING' },
    })

    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${target.workId}`])
  })

  it('carries the public projection only: no email, profile settings or other private fields', async () => {
    const { viewer, friend } = await viewerWithFriend('bs137-private')
    const { workId } = await newWork(['https://covers.example/p.jpg'])

    await prisma.user.update({
      where: { id: friend.id },
      data: {
        bio: 'Приватна біографія',
        avatarUrl: 'https://avatars.example/f.png',
        libraryVisibility: 'PRIVATE',
      },
    })
    await put(friend, workId, 'READING').expect(200)

    const res = await request(server())
      .get(url('/me/friends/reading'))
      .set('Cookie', viewer.cookie)
      .expect(200)
    const body = res.body as { items: Record<string, unknown>[] }
    const [item] = body.items
    const friendRow = await prisma.user.findUniqueOrThrow({ where: { id: friend.id } })

    expect(Object.keys(res.body as object).sort()).toEqual(['hasFriends', 'items', 'nextCursor'])
    expect(Object.keys(item!).sort()).toEqual([
      'authors',
      'coverUrl',
      'friend',
      'updatedAt',
      'work',
    ])
    expect(item!.friend).toEqual({
      id: friend.id,
      displayName: friend.displayName,
      avatarUrl: 'https://avatars.example/f.png',
    })
    expect(Object.keys(item!.work as object).sort()).toEqual(['id', 'title'])

    const raw = JSON.stringify(res.body)

    for (const secret of [
      friendRow.email,
      friendRow.passwordHash,
      'Приватна біографія',
      'libraryVisibility',
      'showHolderNames',
      'emailVerified',
      'telegramChatId',
      'status',
    ]) {
      expect(raw).not.toContain(secret)
    }

    // The viewer's own READING is not part of the viewer's own feed.
    await put(viewer, workId, 'READING').expect(200)
    expect(await pairsOf(viewer)).toEqual([`${friend.id}:${workId}`])
  })

  it('issues the same number of SQL statements for one friend and one item as for many', async () => {
    const small = await viewerWithFriend('bs137-sql1')
    const big = await registerAccount(app, 'bs137-sql2-v')
    const friends = await Promise.all(
      Array.from({ length: 3 }, (_, index) => registerAccount(app, `bs137-sql2-${String(index)}`)),
    )
    const lone = await newWork(['https://covers.example/s.jpg'])
    const works = await Promise.all(
      Array.from({ length: 4 }, () =>
        newWork(['https://covers.example/1.jpg', null, 'https://covers.example/2.jpg']),
      ),
    )

    await put(small.friend, lone.workId, 'READING').expect(200)

    for (const friend of friends) {
      await befriend(app, big, friend)

      for (const work of works) await put(friend, work.workId, 'READING').expect(200)
    }

    const statements = jest.spyOn(Client.prototype, 'query')

    try {
      const countFor = async (account: Account): Promise<number> => {
        statements.mockClear()
        const feed = await feedOf(account)

        expect(feed.items.length).toBeGreaterThan(0)

        return statements.mock.calls.length
      }

      const few = await countFor(small.viewer)

      expect(few).toBeGreaterThan(0)
      expect(await countFor(big)).toBe(few)
      expect((await feedOf(big)).items).toHaveLength(12)
    } finally {
      statements.mockRestore()
    }
  })
})
