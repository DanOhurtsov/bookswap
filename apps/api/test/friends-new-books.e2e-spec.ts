import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  FRIENDS_NEW_BOOKS_LIMITS,
  apiErrorSchema,
  friendsNewBooksResponseSchema,
  type FriendsNewBooksResponse,
  type Visibility,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  approvedLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * BS-147 (docs/plan/bs-147-home-design.md, «Нове в бібліотеках друзів»): `GET /me/friends/new-books`.
 * Every test reads the feed of a viewer of its own: the e2e files share one database, and a feed is
 * everything the viewer's friends have added. The time a copy was added is set here explicitly where
 * the order matters, so no test depends on how fast the requests before it ran.
 */
describe('BS-147: new books in my friends’ libraries (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  const server = () => app.getHttpServer()

  async function feedOf(account: Account): Promise<FriendsNewBooksResponse> {
    const res = await request(server())
      .get(url('/me/friends/new-books'))
      .set('Cookie', account.cookie)
      .expect(200)

    return friendsNewBooksResponseSchema.parse(res.body)
  }

  /** `friendId:workId` of every card, in the order of the feed. */
  async function cardsOf(account: Account): Promise<string[]> {
    const feed = await feedOf(account)

    return feed.items.map((item) => `${item.friend.id}:${item.work.id}`)
  }

  const card = (friend: Account, shelf: Pick<Shelf, 'workId'>): string =>
    `${friend.id}:${shelf.workId}`

  /** One more copy of an edition that already exists. */
  async function addCopy(
    owner: Account,
    editionId: string,
    visibility: Visibility = 'FRIENDS',
  ): Promise<string> {
    const res = await request(server())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId, visibility })
      .expect(201)

    return (res.body as { copy: { id: string } }).copy.id
  }

  async function newEdition(owner: Account, workId: string, coverUrl?: string): Promise<string> {
    const res = await request(server())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', owner.cookie)
      .send({ publisher: 'КСД', year: 2021, ...(coverUrl === undefined ? {} : { coverUrl }) })
      .expect(201)

    return (res.body as { edition: { id: string } }).edition.id
  }

  /** `Copy.createdAt` is the time of adding; tests pin it to make the order explicit. */
  async function addedAt(copyId: string, iso: string): Promise<void> {
    await prisma.copy.update({ where: { id: copyId }, data: { createdAt: new Date(iso) } })
  }

  /** A shelf copy added at `iso`. */
  async function shelfAt(
    owner: Account,
    iso: string,
    visibility: Visibility = 'FRIENDS',
  ): Promise<Shelf> {
    const shelf = await createShelfCopy(app, owner, visibility)

    await addedAt(shelf.copyId, iso)

    return shelf
  }

  async function setProfile(account: Account, body: Record<string, unknown>): Promise<void> {
    await request(server()).patch(url('/me')).set('Cookie', account.cookie).send(body).expect(200)
  }

  async function setCopyVisibility(
    owner: Account,
    copyId: string,
    visibility: Visibility,
  ): Promise<void> {
    await request(server())
      .patch(url(`/me/library/${copyId}`))
      .set('Cookie', owner.cookie)
      .send({ visibility })
      .expect(200)
  }

  async function viewerWithFriends(
    prefix: string,
    count: number,
  ): Promise<{ viewer: Account; friends: Account[] }> {
    const viewer = await registerAccount(app, `${prefix}-v`)
    const friends: Account[] = []

    for (let index = 0; index < count; index += 1) {
      const friend = await registerAccount(app, `${prefix}-f${String(index)}`)

      await befriend(app, viewer, friend)
      friends.push(friend)
    }

    return { viewer, friends }
  }

  /** Minute `n` of a fixed day: later `n` — newer. */
  const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString()

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  it('without a session it is 401 with a code', async () => {
    const res = await request(server()).get(url('/me/friends/new-books')).expect(401)

    expect(apiErrorSchema.parse(res.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
  })

  it('no friends: hasFriends false and no cards, whatever strangers and pending requests hold', async () => {
    const viewer = await registerAccount(app, 'bs147-alone')
    const stranger = await registerAccount(app, 'bs147-alone-s')
    const asked = await registerAccount(app, 'bs147-alone-p')

    await setProfile(stranger, { libraryVisibility: 'PUBLIC' })
    await createShelfCopy(app, stranger, 'PUBLIC')
    await createShelfCopy(app, asked)
    // A request in one direction only: not a friendship yet.
    await request(server())
      .post(url('/friends/requests'))
      .set('Cookie', viewer.cookie)
      .send({ userId: asked.id })
      .expect(201)

    expect(await feedOf(viewer)).toEqual({ hasFriends: false, items: [] })
  })

  it('friends with nothing to show: hasFriends true and no cards', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-idle', 1)
    const friend = friends[0]!

    await createShelfCopy(app, friend, 'PRIVATE')
    // Their own books are not news to the viewer.
    await createShelfCopy(app, viewer)

    expect(await feedOf(viewer)).toEqual({ hasFriends: true, items: [] })
  })

  it('a card: the friend as a public user, the work, its authors, its edition cover and when it was added', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-card', 1)
    const friend = friends[0]!
    const shelf = await createShelfCopy(app, friend)
    const covered = await newEdition(friend, shelf.workId, 'https://covers.example/bs147.jpg')
    const copyId = await addCopy(friend, covered)

    await addedAt(shelf.copyId, at(1))
    await addedAt(copyId, at(2))

    const res = await request(server())
      .get(url('/me/friends/new-books'))
      .set('Cookie', viewer.cookie)
      .expect(200)
    const feed = friendsNewBooksResponseSchema.parse(res.body)
    const [only] = feed.items
    const work = await prisma.work.findUniqueOrThrow({
      where: { id: shelf.workId },
      select: { title: true },
    })

    expect(feed.items).toHaveLength(1)
    expect(only).toEqual({
      friend: {
        id: friend.id,
        displayName: friend.displayName,
        handle: expect.any(String) as string,
        avatarUrl: null,
      },
      work: { id: shelf.workId, title: work.title },
      authors: [expect.objectContaining({ role: 'AUTHOR', position: 0 })],
      coverUrl: 'https://covers.example/bs147.jpg',
      addedAt: at(2),
    })
    // Nothing private of the friend leaks: no e-mail anywhere in the body.
    expect(JSON.stringify(res.body)).not.toContain('@example.com')
  })

  it('newest first; at the same time — by copy id, the same on every read', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-order', 3)
    const [one, two, three] = [friends[0]!, friends[1]!, friends[2]!]
    const oldest = await shelfAt(one, at(1))
    const newest = await shelfAt(two, at(5))
    const tiedA = await shelfAt(three, at(3))
    const tiedB = await shelfAt(one, at(3))
    const tied = [
      { friend: three, shelf: tiedA },
      { friend: one, shelf: tiedB },
    ].sort((x, y) => (x.shelf.copyId < y.shelf.copyId ? 1 : -1))

    const expected = [
      card(two, newest),
      ...tied.map(({ friend, shelf }) => card(friend, shelf)),
      card(one, oldest),
    ]

    expect(await cardsOf(viewer)).toEqual(expected)
    expect(await cardsOf(viewer)).toEqual(expected)
  })

  it('one card per friend and work, by its newest copy; two friends with the same work — two cards', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-dup', 2)
    const [one, two] = [friends[0]!, friends[1]!]
    const shelf = await shelfAt(one, at(1))
    const second = await newEdition(one, shelf.workId, 'https://covers.example/second.jpg')
    const again = await addCopy(one, second)
    const twosCopy = await addCopy(two, shelf.editionId)

    await addedAt(again, at(4))
    await addedAt(twosCopy, at(2))
    // The viewer has the same work too: it stays in the feed.
    await addCopy(viewer, shelf.editionId)

    const feed = await feedOf(viewer)

    expect(feed.items.map((item) => `${item.friend.id}:${item.work.id}`)).toEqual([
      card(one, shelf),
      card(two, shelf),
    ])
    expect(feed.items[0]).toMatchObject({
      addedAt: at(4),
      coverUrl: 'https://covers.example/second.jpg',
    })
    expect(feed.items[1]).toMatchObject({ addedAt: at(2), coverUrl: null })
  })

  it(`at most ${String(FRIENDS_NEW_BOOKS_LIMITS.perFriend)} per friend and ${String(FRIENDS_NEW_BOOKS_LIMITS.total)} in all; a bulk import leaves room for the others`, async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-limits', 5)
    const [importer, ...others] = friends as [Account, ...Account[]]
    const imported: Shelf[] = []

    // An import adds a whole shelf in one transaction: every copy has the same time, the newest.
    for (let index = 0; index < 20; index += 1) imported.push(await shelfAt(importer, at(100)))

    const older: { friend: Account; shelf: Shelf; minute: number }[] = []
    let minute = 0

    for (const friend of others) {
      for (let index = 0; index < 3; index += 1) {
        minute += 1
        older.push({ friend, shelf: await shelfAt(friend, at(minute)), minute })
      }
    }

    const importerCards = [...imported]
      .sort((x, y) => (x.copyId < y.copyId ? 1 : -1))
      .slice(0, FRIENDS_NEW_BOOKS_LIMITS.perFriend)
      .map((shelf) => card(importer, shelf))
    const othersCards = [...older]
      .sort((x, y) => y.minute - x.minute)
      .slice(0, FRIENDS_NEW_BOOKS_LIMITS.total - FRIENDS_NEW_BOOKS_LIMITS.perFriend)
      .map(({ friend, shelf }) => card(friend, shelf))

    const cards = await cardsOf(viewer)

    expect(cards).toEqual([...importerCards, ...othersCards])
    expect(cards).toHaveLength(FRIENDS_NEW_BOOKS_LIMITS.total)
  })

  describe('visibility of the library and of the copy (§9)', () => {
    it.each<[Visibility, Visibility, boolean]>([
      ['PUBLIC', 'PUBLIC', true],
      ['PUBLIC', 'FRIENDS', true],
      ['FRIENDS', 'PUBLIC', true],
      ['FRIENDS', 'FRIENDS', true],
      ['PUBLIC', 'PRIVATE', false],
      ['FRIENDS', 'PRIVATE', false],
      ['PRIVATE', 'PUBLIC', false],
      ['PRIVATE', 'FRIENDS', false],
    ])('library %s, copy %s → shown: %p', async (library, copy, shown) => {
      const { viewer, friends } = await viewerWithFriends(`bs147-vis-${library}-${copy}`, 1)
      const friend = friends[0]!
      const shelf = await createShelfCopy(app, friend, copy)

      await setProfile(friend, { libraryVisibility: library })

      expect(await cardsOf(viewer)).toEqual(shown ? [card(friend, shelf)] : [])
    })
  })

  it.each(['viewer', 'friend'] as const)(
    'a block by the %s hides the friend’s books',
    async (blocker) => {
      const { viewer, friends } = await viewerWithFriends(`bs147-block-${blocker}`, 2)
      const [blocked, other] = [friends[0]!, friends[1]!]

      await setProfile(blocked, { libraryVisibility: 'PUBLIC' })
      await createShelfCopy(app, blocked, 'PUBLIC')
      const kept = await createShelfCopy(app, other)
      const [by, target] = blocker === 'viewer' ? [viewer, blocked] : [blocked, viewer]

      await request(server())
        .post(url(`/friends/${target.id}/block`))
        .set('Cookie', by.cookie)
        .expect(204)

      expect(await cardsOf(viewer)).toEqual([card(other, kept)])
    },
  )

  it('a friend of a friend stays out, even with the library opened to friends of friends', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-fof', 1)
    const mutual = friends[0]!
    const owner = await registerAccount(app, 'bs147-fof-o')

    await befriend(app, mutual, owner)
    await setProfile(owner, { friendsOfFriendsAccess: true, libraryVisibility: 'PUBLIC' })
    await createShelfCopy(app, owner, 'PUBLIC')

    expect(await feedOf(viewer)).toEqual({ hasFriends: true, items: [] })
  })

  it('only copies at home: an archived, a reserved or a lent copy stays out; paused requests do not hide', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-avail', 1)
    const friend = friends[0]!
    const borrower = await registerAccount(app, 'bs147-avail-b')

    await befriend(app, friend, borrower)

    const archived = await createShelfCopy(app, friend)
    const reserved = await createShelfCopy(app, friend)
    const lent = await createShelfCopy(app, friend)
    const home = await createShelfCopy(app, friend)

    await request(server())
      .post(url(`/me/library/${archived.copyId}/archive`))
      .set('Cookie', friend.cookie)
      .expect(200)
    await approvedLoan(app, friend, borrower, reserved.copyId)
    await handedOverLoan(app, friend, borrower, lent.copyId)
    await setProfile(friend, { loanRequestsPaused: true })

    expect(await cardsOf(viewer)).toEqual([card(friend, home)])
  })

  it('a returned book comes back with the time it was added, not the time of the return', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-return', 2)
    const [owner, other] = [friends[0]!, friends[1]!]
    const borrower = await registerAccount(app, 'bs147-return-b')

    await befriend(app, owner, borrower)

    const lentBook = await shelfAt(owner, at(1))
    const newer = await shelfAt(other, at(2))
    const loanId = await handedOverLoan(app, owner, borrower, lentBook.copyId)

    expect(await cardsOf(viewer)).toEqual([card(other, newer)])

    await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

    const feed = await feedOf(viewer)

    expect(feed.items.map((item) => `${item.friend.id}:${item.work.id}`)).toEqual([
      card(other, newer),
      card(owner, lentBook),
    ])
    expect(feed.items[1]?.addedAt).toBe(at(1))
  })

  it('the next read follows a change of friendship or privacy', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-change', 2)
    const [closing, leaving] = [friends[0]!, friends[1]!]
    const closed = await shelfAt(closing, at(2))
    const hidden = await shelfAt(closing, at(3))
    const gone = await shelfAt(leaving, at(1))

    expect(await cardsOf(viewer)).toEqual([
      card(closing, hidden),
      card(closing, closed),
      card(leaving, gone),
    ])

    await setCopyVisibility(closing, hidden.copyId, 'PRIVATE')
    expect(await cardsOf(viewer)).toEqual([card(closing, closed), card(leaving, gone)])

    await setProfile(closing, { libraryVisibility: 'PRIVATE' })
    expect(await cardsOf(viewer)).toEqual([card(leaving, gone)])

    await setProfile(closing, { libraryVisibility: 'FRIENDS' })
    expect(await cardsOf(viewer)).toEqual([card(closing, closed), card(leaving, gone)])

    await request(server())
      .delete(url(`/friends/${leaving.id}`))
      .set('Cookie', viewer.cookie)
      .expect(204)
    expect(await cardsOf(viewer)).toEqual([card(closing, closed)])
  })

  it('a merged work shows as the canonical one', async () => {
    const { viewer, friends } = await viewerWithFriends('bs147-merge', 1)
    const friend = friends[0]!
    const source = await createShelfCopy(app, friend)
    const target = await createShelfCopy(app, friend)

    await addedAt(source.copyId, at(2))
    await addedAt(target.copyId, at(1))
    await new MergeService(prisma).merge(source.workId, target.workId)

    // Both copies are now of the target work: one card, by the newer copy.
    const feed = await feedOf(viewer)

    expect(feed.items.map((item) => item.work.id)).toEqual([target.workId])
    expect(feed.items[0]?.addedAt).toBe(at(2))
  })
})
