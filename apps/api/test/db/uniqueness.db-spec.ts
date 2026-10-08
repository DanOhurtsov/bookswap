import { createGraph, createUser, expectRejection } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'
import {
  AuthorRole,
  Channel,
  FriendshipStatus,
  NotificationType,
} from '../../src/generated/prisma/enums'
import type { PrismaClient } from '../../src/generated/prisma/client'

describe('унікальні обмеження §4', () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createTestPrismaClient()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('email користувача унікальний', async () => {
    const data = { email: 'dup@example.com', passwordHash: 'x', displayName: 'Дубль' }
    await prisma.user.create({ data })

    await expectRejection(prisma.user.create({ data }), /email/i)
  })

  it('telegramChatId унікальний — один чат не може бути в двох акаунтів (§7.4)', async () => {
    await prisma.user.create({
      data: {
        email: 'tg1@example.com',
        passwordHash: 'x',
        displayName: 'Раз',
        telegramChatId: '1',
      },
    })

    await expectRejection(
      prisma.user.create({
        data: {
          email: 'tg2@example.com',
          passwordHash: 'x',
          displayName: 'Два',
          telegramChatId: '1',
        },
      }),
      /telegramChatId/i,
    )
  })

  it('дружба — один рядок на пару (§4.3)', async () => {
    const [userAId, userBId] = [await createUser(prisma), await createUser(prisma)].sort()

    if (userAId === undefined || userBId === undefined) throw new Error('Недосяжно')

    await prisma.friendship.create({
      data: { userAId, userBId, requestedById: userAId, status: FriendshipStatus.ACCEPTED },
    })

    await expectRejection(
      prisma.friendship.create({
        data: { userAId, userBId, requestedById: userBId, status: FriendshipStatus.PENDING },
      }),
      /userAId|userBId/,
    )
  })

  it('ISBN-13 видання унікальний, але кілька видань без ISBN співіснують', async () => {
    const graph = await createGraph(prisma)
    const edition = {
      workId: graph.workId,
      createdById: graph.ownerId,
      textKind: 'UNKNOWN' as const,
      isbn13: '9786171262737',
    }

    await prisma.edition.create({ data: edition })
    await expectRejection(prisma.edition.create({ data: edition }), /isbn13/i)

    // NULL в унікальному індексі PostgreSQL не конфліктує сам із собою — і це саме
    // те, що потрібно: більшість старих видань ISBN не має.
    await prisma.edition.create({
      data: { workId: graph.workId, createdById: graph.ownerId, textKind: 'UNKNOWN' },
    })
    await prisma.edition.create({
      data: { workId: graph.workId, createdById: graph.ownerId, textKind: 'UNKNOWN' },
    })

    expect(await prisma.edition.count({ where: { isbn13: null } })).toBe(3)
  })

  it('один користувач — один відгук на твір (§6.7)', async () => {
    const graph = await createGraph(prisma)
    const review = { workId: graph.workId, userId: graph.borrowerId, rating: 5 }

    await prisma.review.create({ data: review })
    await expectRejection(prisma.review.create({ data: review }), /workId|userId/)
  })

  it('один користувач — одна оцінка перекладу', async () => {
    const graph = await createGraph(prisma)
    const rating = { translationId: graph.translationId, userId: graph.borrowerId, rating: 4 }

    await prisma.translationRating.create({ data: rating })
    await expectRejection(prisma.translationRating.create({ data: rating }), /translationId|userId/)
  })

  it('твір потрапляє у вішлист користувача один раз', async () => {
    const graph = await createGraph(prisma)
    const item = { userId: graph.borrowerId, workId: graph.workId }

    await prisma.wishlistItem.create({ data: item })
    await expectRejection(prisma.wishlistItem.create({ data: item }), /userId|workId/)
  })

  it('WorkAuthor — складений ключ (work, author, role): та сама людина в різних ролях', async () => {
    const graph = await createGraph(prisma)
    const author = await prisma.author.create({
      data: { name: 'Автор і перекладач', nameNorm: 'автор і перекладач' },
    })
    const link = { workId: graph.workId, authorId: author.id }

    await prisma.workAuthor.create({ data: { ...link, role: AuthorRole.AUTHOR, position: 0 } })
    await prisma.workAuthor.create({ data: { ...link, role: AuthorRole.ILLUSTRATOR, position: 1 } })

    await expectRejection(
      prisma.workAuthor.create({ data: { ...link, role: AuthorRole.AUTHOR, position: 2 } }),
      /workId|authorId|role/,
    )

    expect(await prisma.workAuthor.count({ where: link })).toBe(2)
  })

  it('NotificationPreference — один рядок на (користувач, тип, канал) (§7.6)', async () => {
    const userId = await createUser(prisma)
    const pref = { userId, type: NotificationType.LOAN_REQUESTED, channel: Channel.EMAIL }

    await prisma.notificationPreference.create({ data: pref })
    await prisma.notificationPreference.create({ data: { ...pref, channel: Channel.TELEGRAM } })

    await expectRejection(
      prisma.notificationPreference.create({ data: pref }),
      /userId|type|channel/,
    )

    expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(2)
  })

  /**
   * §4.7 «один користувач — один відгук на твір» після R5 тримає не суцільний
   * unique, а частковий `one_active_review_per_work_user`. Правило те саме, поки
   * рецензія активна; архівна копія — та, що програла мерж, — під нього не
   * підпадає, інакше §6.3 довелося б видаляти чужий текст.
   */
  it('Review — один АКТИВНИЙ відгук на (твір, користувач), архівні не рахуються (§4.7, R5)', async () => {
    const graph = await createGraph(prisma)
    const review = { workId: graph.workId, userId: graph.ownerId, rating: 5 }

    const active = await prisma.review.create({ data: review })

    await expectRejection(prisma.review.create({ data: review }), /workId|userId/)

    // Той самий рядок, але заархівований мержем, співіснує з активним.
    await prisma.review.create({
      data: { ...review, archivedAt: new Date(), archivedByMergeSourceId: graph.workId },
    })

    expect(await prisma.review.count({ where: { workId: graph.workId } })).toBe(2)
    expect(await prisma.review.count({ where: { workId: graph.workId, archivedAt: null } })).toBe(1)
    expect(active.archivedAt).toBeNull()
  })

  it('TelegramLinkToken — токен є первинним ключем (§7.4)', async () => {
    const userId = await createUser(prisma)
    const token = { token: 'link-token', userId, expiresAt: new Date(Date.now() + 600_000) }

    await prisma.telegramLinkToken.create({ data: token })
    await expectRejection(prisma.telegramLinkToken.create({ data: token }), /token/i)
  })
})
