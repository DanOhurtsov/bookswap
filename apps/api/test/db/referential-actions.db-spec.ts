import { createGraph, createUser, expectRejection } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'
import { Channel, LoanStatus, NotificationType } from '../../src/generated/prisma/enums'
import type { PrismaClient } from '../../src/generated/prisma/client'

/**
 * Поведінка зовнішніх ключів §4. Тут важливе не лише те, що каскади працюють, а й
 * те, що RESTRICT'и справді блокують: §5.2 вимагає, щоб примірник не можна було
 * прибрати, поки на ньому висить активний лоан.
 */
describe('referential actions', () => {
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

  it('видалення Work зносить переклади, видання, відгуки й вішлист', async () => {
    const graph = await createGraph(prisma)
    await prisma.review.create({
      data: { workId: graph.workId, userId: graph.borrowerId, rating: 5 },
    })
    await prisma.wishlistItem.create({ data: { workId: graph.workId, userId: graph.borrowerId } })

    // Copy заважає: Edition → Copy має RESTRICT, тож спершу прибираємо примірник.
    await prisma.copy.delete({ where: { id: graph.copyId } })
    await prisma.work.delete({ where: { id: graph.workId } })

    expect(await prisma.translation.count()).toBe(0)
    expect(await prisma.edition.count()).toBe(0)
    expect(await prisma.review.count()).toBe(0)
    expect(await prisma.wishlistItem.count()).toBe(0)
  })

  it('видалення Notification зносить свої доставки (§4.8)', async () => {
    const userId = await createUser(prisma)
    const notification = await prisma.notification.create({
      data: { userId, type: NotificationType.LOAN_REQUESTED, payload: { loanId: 'x' } },
    })

    await prisma.notificationDelivery.create({
      data: { notificationId: notification.id, channel: Channel.EMAIL },
    })
    await prisma.notificationDelivery.create({
      data: { notificationId: notification.id, channel: Channel.TELEGRAM },
    })

    await prisma.notification.delete({ where: { id: notification.id } })

    expect(await prisma.notificationDelivery.count()).toBe(0)
  })

  it('DEL4: Copy з будь-яким Loan не видалити — RESTRICT зберігає історію (§4.6, M3)', async () => {
    for (const status of Object.values(LoanStatus)) {
      await truncateAll(prisma)

      const graph = await createGraph(prisma)
      const loan = await prisma.loan.create({
        data: {
          copyId: graph.copyId,
          ownerId: graph.ownerId,
          borrowerId: graph.borrowerId,
          status,
        },
      })

      await expectRejection(
        prisma.copy.delete({ where: { id: graph.copyId } }),
        /Loan_copyId_fkey|foreign key/i,
      )

      expect(await prisma.copy.count({ where: { id: graph.copyId } })).toBe(1)
      expect(await prisma.loan.count({ where: { id: loan.id } })).toBe(1)
    }
  })

  it('DEL1: Copy без Loan видаляється', async () => {
    const graph = await createGraph(prisma)

    await prisma.copy.delete({ where: { id: graph.copyId } })

    expect(await prisma.copy.count()).toBe(0)
  })

  it('видалення Edition із примірниками заблоковане', async () => {
    const graph = await createGraph(prisma)

    await expectRejection(
      prisma.edition.delete({ where: { id: graph.editionId } }),
      /Copy_editionId_fkey|foreign key/i,
    )
  })

  it('користувача з активним лоаном не видалити — фізична книга в нього (§5.2)', async () => {
    const graph = await createGraph(prisma)
    await prisma.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: graph.borrowerId,
        status: LoanStatus.HANDED_OVER,
      },
    })

    await expectRejection(
      prisma.user.delete({ where: { id: graph.borrowerId } }),
      /Loan_borrowerId_fkey|foreign key/i,
    )
  })

  it('видалення дружби не чіпає ні бібліотеки, ні лоани (§5.2)', async () => {
    const graph = await createGraph(prisma)
    const [userAId, userBId] = [graph.ownerId, graph.borrowerId].sort()

    if (userAId === undefined || userBId === undefined) throw new Error('Недосяжно')

    const friendship = await prisma.friendship.create({
      data: { userAId, userBId, requestedById: userAId },
    })
    await prisma.loan.create({
      data: {
        copyId: graph.copyId,
        ownerId: graph.ownerId,
        borrowerId: graph.borrowerId,
        status: LoanStatus.HANDED_OVER,
      },
    })

    await prisma.friendship.delete({ where: { id: friendship.id } })

    expect(await prisma.loan.count({ where: { status: LoanStatus.HANDED_OVER } })).toBe(1)
    expect(await prisma.copy.count()).toBe(1)
  })

  it('Work.mergedIntoId лишає старий запис живим (§6.3)', async () => {
    const graph = await createGraph(prisma)
    const canonical = await prisma.work.create({
      data: {
        title: 'Шантарам',
        titleNorm: 'шантарам',
        origLang: 'en',
        createdById: graph.ownerId,
      },
    })

    await prisma.work.update({
      where: { id: graph.workId },
      data: { mergedIntoId: canonical.id },
    })

    const merged = await prisma.work.findUniqueOrThrow({ where: { id: graph.workId } })

    expect(merged.mergedIntoId).toBe(canonical.id)
    expect(await prisma.work.count()).toBe(2)
  })
})
