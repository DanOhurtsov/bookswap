import { createGraph, createUser, expectRejection } from './fixtures'
import { createTestPrismaClient, truncateAll } from './test-database'
import { isUniqueViolationOn } from '../../src/common/prisma-errors'
import { ONE_ACTIVE_LOAN_PER_COPY } from '../../src/loans/loan.service'
import type { PrismaClient } from '../../src/generated/prisma/client'

/**
 * CHECK-обмеження зі §5.3, дописані руками в міграції `loan_state_machine`.
 *
 * Перевіряються саме на рівні БД: `LoanService` тримає ті самі інваріанти, але
 * база — це остання лінія, яка діє й тоді, коли дані правлять скриптом, seed'ом
 * чи міграцією в обхід коду.
 */
describe('CHECK-обмеження позичання (§5.3)', () => {
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

  describe('loan_borrower_not_owner (§5.3.4)', () => {
    it('позичити самому собі не можна', async () => {
      const graph = await createGraph(prisma)

      await expectRejection(
        prisma.loan.create({
          data: { copyId: graph.copyId, ownerId: graph.ownerId, borrowerId: graph.ownerId },
        }),
        /loan_borrower_not_owner/,
      )
    })

    it('різні люди — рядок проходить', async () => {
      const graph = await createGraph(prisma)

      const loan = await prisma.loan.create({
        data: { copyId: graph.copyId, ownerId: graph.ownerId, borrowerId: graph.borrowerId },
      })

      expect(loan.status).toBe('REQUESTED')
    })
  })

  /**
   * §5.3.2 в ослабленій формі. Дослівна еквівалентність із тексту специфікації
   * суперечить її ж таблиці §5.1: `RESERVED` (апрув тримача не змінює) і
   * `UNAVAILABLE` («власник тимчасово не дає») теж означають книжку вдома.
   */
  describe('інваріант §5.3.2 трьома імплікаціями', () => {
    it('AVAILABLE із чужим тримачем не проходить', async () => {
      const graph = await createGraph(prisma)

      await expectRejection(
        prisma.copy.update({
          where: { id: graph.copyId },
          data: { currentHolderId: graph.borrowerId, status: 'AVAILABLE' },
        }),
        /copy_available_is_home/,
      )
    })

    it('RESERVED із чужим тримачем не проходить — «домовлено» означає «ще вдома»', async () => {
      // §5.2: підтвердження ≠ передача. Якби RESERVED допускав чужого тримача,
      // апрув міг би мовчки переставити володіння — рівно те, що §5.1 забороняє.
      const graph = await createGraph(prisma)

      await expectRejection(
        prisma.copy.update({
          where: { id: graph.copyId },
          data: { currentHolderId: graph.borrowerId, status: 'RESERVED' },
        }),
        /copy_away_is_lent_or_unavailable/,
      )
    })

    it('RESERVED, яку тримає контакт-гість, — коректний стан (Stage 10, 10i.1: передано, не підтверджено)', async () => {
      const graph = await createGraph(prisma)
      const contact = await prisma.externalBorrower.create({
        data: { ownerId: graph.ownerId, alias: 'Гість' },
      })

      const copy = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { status: 'RESERVED', currentHolderId: null, heldByContactId: contact.id },
      })

      expect(copy.status).toBe('RESERVED')
      expect(copy.heldByContactId).toBe(contact.id)
    })

    it('RESERVED без тримача взагалі (NULL/NULL) не проходить — виняток лише для контакту', async () => {
      const graph = await createGraph(prisma)

      await expectRejection(
        prisma.copy.update({
          where: { id: graph.copyId },
          data: { status: 'RESERVED', currentHolderId: null },
        }),
        /copy_away_is_lent_or_unavailable/,
      )
    })

    it('RESERVED і користувач-тримач, і контакт одразу — copy_single_holder', async () => {
      const graph = await createGraph(prisma)
      const contact = await prisma.externalBorrower.create({
        data: { ownerId: graph.ownerId, alias: 'Гість' },
      })

      await expectRejection(
        prisma.copy.update({
          where: { id: graph.copyId },
          data: { status: 'RESERVED', heldByContactId: contact.id },
        }),
        /copy_single_holder/,
      )
    })

    it('LENT_OUT із власником-тримачем не проходить', async () => {
      const graph = await createGraph(prisma)

      await expectRejection(
        prisma.copy.update({ where: { id: graph.copyId }, data: { status: 'LENT_OUT' } }),
        /copy_lent_out_is_away/,
      )
    })

    it('LENT_OUT у позичальника — коректний стан', async () => {
      const graph = await createGraph(prisma)

      const copy = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { currentHolderId: graph.borrowerId, status: 'LENT_OUT' },
      })

      expect(copy.currentHolderId).toBe(graph.borrowerId)
    })

    it('UNAVAILABLE — обидва прочитання дозволені', async () => {
      // §4.5: «власник тимчасово не дає» (книжка вдома) і §5.1 `LOST` (книжка
      // лишилася в позичальника) — той самий статус із різним тримачем. Саме тому
      // третьої імплікації для UNAVAILABLE немає.
      const graph = await createGraph(prisma)

      const home = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { status: 'UNAVAILABLE' },
      })

      expect(home.currentHolderId).toBe(graph.ownerId)

      const lost = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { currentHolderId: graph.borrowerId, status: 'UNAVAILABLE' },
      })

      expect(lost.currentHolderId).toBe(graph.borrowerId)
    })

    it('RESERVED і AVAILABLE вдома проходять', async () => {
      const graph = await createGraph(prisma)

      const reserved = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { status: 'RESERVED' },
      })

      expect(reserved.status).toBe('RESERVED')

      const available = await prisma.copy.update({
        where: { id: graph.copyId },
        data: { status: 'AVAILABLE' },
      })

      expect(available.status).toBe('AVAILABLE')
    })
  })

  /**
   * Пінування форми помилки P2002 для **часткового** індексу, якого немає в
   * схемі Prisma.
   *
   * `LoanService` перетворює на `LOAN_ALREADY_APPROVED` лише порушення саме цього
   * обмеження — будь-який інший `P2002` летить далі незміненим. Точна форма
   * `meta` версійно залежна, тож вона не припускається, а перевіряється тут, на
   * живій базі. Якщо Prisma колись перестане класти туди назву індексу,
   * зламається цей тест, а не мовчазне перетворення чужої помилки на доменний код.
   */
  describe('розпізнавання P2002 за назвою обмеження', () => {
    it('порушення one_active_loan_per_copy впізнається', async () => {
      const graph = await createGraph(prisma)
      const rival = await createUser(prisma, 'Конкурент')

      await prisma.loan.create({
        data: {
          copyId: graph.copyId,
          ownerId: graph.ownerId,
          borrowerId: graph.borrowerId,
          status: 'APPROVED',
        },
      })

      const error = await expectRejection(
        prisma.loan.create({
          data: {
            copyId: graph.copyId,
            ownerId: graph.ownerId,
            borrowerId: rival,
            status: 'APPROVED',
          },
        }),
        /Unique constraint failed/,
      )

      expect(isUniqueViolationOn(error, ONE_ACTIVE_LOAN_PER_COPY)).toBe(true)
    })

    it('чуже порушення унікальності НЕ видається за нього', async () => {
      // Інакше «зайнятий email» перетворився б на «примірник уже обіцяно іншому» —
      // повідомлення, яке впевнено бреше про причину.
      await prisma.user.create({
        data: { email: 'taken@example.com', passwordHash: 'x', displayName: 'Перший' },
      })

      const error = await expectRejection(
        prisma.user.create({
          data: { email: 'taken@example.com', passwordHash: 'x', displayName: 'Другий' },
        }),
        /Unique constraint failed/,
      )

      expect(isUniqueViolationOn(error, ONE_ACTIVE_LOAN_PER_COPY)).toBe(false)
    })
  })
})
