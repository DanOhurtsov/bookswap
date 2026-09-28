import { InviteEmailHashCleanupService } from './invite-email-hash-cleanup.service'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Stage 10 (10g, Q5). Той самий інваріант, що й `SessionCleanupService`
 * (`session-cleanup.spec.ts`): поки йде e2e-файл, фонової роботи немає взагалі —
 * ані таймера, ані проходу.
 */
describe('InviteEmailHashCleanupService: розклад', () => {
  const cleanupWith = (mode: 'enabled' | 'disabled', prisma: PrismaService) =>
    new InviteEmailHashCleanupService(prisma, mode)

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("'disabled': таймер не заводиться", () => {
    const prisma = {} as unknown as PrismaService

    cleanupWith('disabled', prisma).onModuleInit()

    expect(jest.getTimerCount()).toBe(0)
  })

  it("'enabled': таймер заводиться", () => {
    const prisma = {} as unknown as PrismaService

    cleanupWith('enabled', prisma).onModuleInit()

    expect(jest.getTimerCount()).toBe(1)
  })
})

describe('InviteEmailHashCleanupService.run()', () => {
  it('обнуляє лише EMAIL-запрошення старші за 7 днів, з непорожнім recipientEmailHash', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 3 })
    const prisma = { invitation: { updateMany } } as unknown as PrismaService
    const service = new InviteEmailHashCleanupService(prisma, 'disabled')
    const now = new Date('2026-10-01T00:00:00.000Z')

    await service.run(now)

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        kind: 'EMAIL',
        recipientEmailHash: { not: null },
        createdAt: { lte: new Date('2026-09-24T00:00:00.000Z') },
      },
      data: { recipientEmailHash: null },
    })
  })

  it('помилка БД не кидає далі — наступний тик спробує знову', async () => {
    const updateMany = jest.fn().mockRejectedValue(new Error('down'))
    const prisma = { invitation: { updateMany } } as unknown as PrismaService
    const service = new InviteEmailHashCleanupService(prisma, 'disabled')

    await expect(service.run(new Date())).resolves.toBeUndefined()
  })
})
