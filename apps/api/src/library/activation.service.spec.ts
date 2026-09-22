import { ACTIVATION_TARGET, activationResponseSchema } from '@bookswap/shared'
import { ActivationService } from './activation.service'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Stage 8h-1, R11.
 *
 * The count is mocked rather than run against PostgreSQL because the rule under
 * test is «what does the owner see at N books», and N is the input. That the
 * database really counts the right rows — own copies only, whatever their
 * status, visibility or holder — is the job of `test/activation.e2e-spec.ts`.
 */
function createService(ownedCopyCount: number): {
  service: ActivationService
  count: jest.Mock
} {
  const count = jest.fn().mockResolvedValue(ownedCopyCount)
  const prisma = { copy: { count } } as unknown as PrismaService

  return { service: new ActivationService(prisma), count }
}

describe('ActivationService.progressOf', () => {
  it('asks once, for the caller own copies, and narrows by nothing else', async () => {
    const { service, count } = createService(4)

    await service.progressOf('user-marta')

    expect(count).toHaveBeenCalledTimes(1)
    // Exact equality, so this also pins what must NOT be there: a `status`,
    // `visibility` or `currentHolderId` clause would fail here. A lent-out,
    // hidden or «temporarily not lending» copy is still a book on the shelf,
    // and narrowing would un-complete the checklist the moment somebody
    // borrowed the tenth book.
    expect(count).toHaveBeenCalledWith({ where: { ownerId: 'user-marta' } })
  })

  it.each([0, 1, 9])('at %i copies keeps asking for books', async (ownedCopyCount) => {
    const { service } = createService(ownedCopyCount)

    await expect(service.progressOf('user-marta')).resolves.toEqual({
      ownedCopyCount,
      target: ACTIVATION_TARGET,
      hasReachedTarget: false,
      nextAction: 'ADD_BOOKS',
    })
  })

  it.each([10, 11, 137])('at %i copies sends the owner to friends', async (ownedCopyCount) => {
    const { service } = createService(ownedCopyCount)

    await expect(service.progressOf('user-marta')).resolves.toEqual({
      ownedCopyCount,
      target: ACTIVATION_TARGET,
      hasReachedTarget: true,
      nextAction: 'INVITE_FRIENDS',
    })
  })

  it.each([0, 1, 9, 10, 11])(
    'builds a response the shared contract accepts at %i copies',
    async (ownedCopyCount) => {
      const { service } = createService(ownedCopyCount)

      const progress = await service.progressOf('user-marta')

      // The schema refuses a response whose fields disagree, so parsing it here
      // is what proves target/hasReachedTarget/nextAction were built from the
      // same count — not merely that each field has a plausible type.
      expect(() => activationResponseSchema.parse(progress)).not.toThrow()
    },
  )

  it('never invents progress the owner does not have', async () => {
    const { service } = createService(0)

    const progress = await service.progressOf('user-marta')

    expect(progress.ownedCopyCount).toBe(0)
    expect(progress.hasReachedTarget).toBe(false)
  })
})
