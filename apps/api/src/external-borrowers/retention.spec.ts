import {
  RETENTION_CLOSED_WINDOW_MS,
  RETENTION_NO_LOAN_WINDOW_MS,
  RETENTION_UNRESOLVED_LOSS_WINDOW_MS,
  recomputeRetainUntil,
  type RetentionTxClient,
} from './retention'

/**
 * Stage 10 (10h, docs/plan/stage-10-real-world-history.md §0.9, RET1–RET5, RET11–RET16,
 * RET19–RET20): формула `retainUntil` — юніт-рівень, без БД, з детермінованим часом. E2E-рівень
 * (`guest-contact-retention.e2e-spec.ts`) підтверджує, що ці самі результати справді записуються
 * реальними переходами під реальними локами; тут перевіряється сама арифметика формули.
 */

interface FakeContact {
  createdAt: Date
  retainUntil: Date | null
}

interface FakeLoan {
  id: string
  status: string
  returnedAt: Date | null
}

interface FakeEvent {
  loanId: string
  type: string
  occurredAt: Date
}

/**
 * `recomputeRetainUntil` викликає лише ці чотири методи (§ `retention.ts`) — фейк типізований
 * рівно під них, без решти делегатів `PrismaService`, і приведений через `unknown`, а не `any`.
 */
interface FakeRetentionClient {
  externalBorrower: {
    findUnique: () => Promise<{ createdAt: Date } | null>
    update: (args: { data: { retainUntil: Date | null } }) => Promise<unknown>
  }
  loan: {
    findMany: () => Promise<FakeLoan[]>
  }
  loanEvent: {
    findMany: () => Promise<FakeEvent[]>
  }
}

function fakeTx(contact: FakeContact, loans: FakeLoan[], events: FakeEvent[]): RetentionTxClient {
  const client: FakeRetentionClient = {
    externalBorrower: {
      findUnique: () => Promise.resolve({ createdAt: contact.createdAt }),
      update: ({ data }) => {
        contact.retainUntil = data.retainUntil

        return Promise.resolve(contact)
      },
    },
    loan: {
      findMany: () =>
        Promise.resolve(
          loans.map((loan) => ({ id: loan.id, status: loan.status, returnedAt: loan.returnedAt })),
        ),
    },
    loanEvent: {
      findMany: () => Promise.resolve(events.map((event) => ({ ...event }))),
    },
  }

  return client as unknown as RetentionTxClient
}

const DAY_MS = 24 * 60 * 60 * 1000

async function retainUntilFor(
  createdAt: Date,
  loans: FakeLoan[],
  events: FakeEvent[],
): Promise<Date | null> {
  const contact: FakeContact = { createdAt, retainUntil: null }
  const tx = fakeTx(contact, loans, events)

  await recomputeRetainUntil(tx, 'c-1')

  return contact.retainUntil
}

describe('recomputeRetainUntil — формула §0.9', () => {
  it('RET5: без жодної позики → createdAt + 90д', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const result = await retainUntilFor(createdAt, [], [])

    expect(result?.getTime()).toBe(createdAt.getTime() + RETENTION_NO_LOAN_WINDOW_MS)
    expect(RETENTION_NO_LOAN_WINDOW_MS).toBe(90 * DAY_MS)
  })

  it('RET1: активна позика (HANDED_OVER) → NULL, незалежно від інших позик', async () => {
    const oldReturn = new Date('2020-01-01T00:00:00.000Z')
    const result = await retainUntilFor(
      new Date('2026-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'HANDED_OVER', returnedAt: null },
        { id: 'l-2', status: 'RETURNED', returnedAt: oldReturn },
      ],
      [],
    )

    expect(result).toBeNull()
  })

  it('RET2/RET3: RETURNED → returnedAt + 90д', async () => {
    const returnedAt = new Date('2026-03-01T12:00:00.000Z')
    const result = await retainUntilFor(
      new Date('2026-01-01T00:00:00.000Z'),
      [{ id: 'l-1', status: 'RETURNED', returnedAt }],
      [],
    )

    expect(result?.getTime()).toBe(returnedAt.getTime() + RETENTION_CLOSED_WINDOW_MS)
  })

  it('RET3: кілька позик — максимум по returnedAt (останнє закриття)', async () => {
    const earlier = new Date('2026-01-10T00:00:00.000Z')
    const later = new Date('2026-03-01T00:00:00.000Z')
    const result = await retainUntilFor(
      new Date('2025-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'RETURNED', returnedAt: earlier },
        { id: 'l-2', status: 'RETURNED', returnedAt: later },
      ],
      [],
    )

    expect(result?.getTime()).toBe(later.getTime() + RETENTION_CLOSED_WINDOW_MS)
  })

  it('RET4/RET12: незакрита LOST → LOAN_LOST.occurredAt + 365д, а не NULL', async () => {
    const lostAt = new Date('2026-01-01T00:00:00.000Z')
    const result = await retainUntilFor(
      new Date('2025-01-01T00:00:00.000Z'),
      [{ id: 'l-1', status: 'LOST', returnedAt: null }],
      [{ loanId: 'l-1', type: 'LOAN_LOST', occurredAt: lostAt }],
    )

    expect(result?.getTime()).toBe(lostAt.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS)
    expect(RETENTION_UNRESOLVED_LOSS_WINDOW_MS).toBe(365 * DAY_MS)
  })

  it('RET12: межа 364/365 днів — сама формула байдужа до "now", лише зсув від occurredAt', async () => {
    const lostAt = new Date('2026-01-01T00:00:00.000Z')
    const result = await retainUntilFor(
      new Date('2020-01-01T00:00:00.000Z'),
      [{ id: 'l-1', status: 'LOST', returnedAt: null }],
      [{ loanId: 'l-1', type: 'LOAN_LOST', occurredAt: lostAt }],
    )
    const day364 = new Date(lostAt.getTime() + 364 * DAY_MS)
    const day365 = new Date(lostAt.getTime() + 365 * DAY_MS)

    expect(result).not.toBeNull()
    expect(result!.getTime() > day364.getTime()).toBe(true)
    expect(result!.getTime()).toBe(day365.getTime())
  })

  it('RET13: дві незакриті LOST з різними occurredAt → максимум із двох 365-денних меж', async () => {
    const earlyLost = new Date('2026-01-01T00:00:00.000Z')
    const lateLost = new Date('2026-04-11T00:00:00.000Z') // +100 днів

    const result = await retainUntilFor(
      new Date('2025-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'LOST', returnedAt: null },
        { id: 'l-2', status: 'LOST', returnedAt: null },
      ],
      [
        { loanId: 'l-1', type: 'LOAN_LOST', occurredAt: earlyLost },
        { loanId: 'l-2', type: 'LOAN_LOST', occurredAt: lateLost },
      ],
    )

    expect(result?.getTime()).toBe(lateLost.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS)
  })

  it('RET11/RET15: незакрита LOST і RETURNED (>90д тому) → максимум із 365д(LOST) і 90д(RETURNED)', async () => {
    const lostAt = new Date('2026-06-01T00:00:00.000Z')
    const returnedAt = new Date('2025-01-01T00:00:00.000Z') // давно закрита

    const result = await retainUntilFor(
      new Date('2024-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'LOST', returnedAt: null },
        { id: 'l-2', status: 'RETURNED', returnedAt },
      ],
      [{ loanId: 'l-1', type: 'LOAN_LOST', occurredAt: lostAt }],
    )
    const lostBound = lostAt.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS
    const returnedBound = returnedAt.getTime() + RETENTION_CLOSED_WINDOW_MS

    expect(lostBound).toBeGreaterThan(returnedBound)
    expect(result?.getTime()).toBe(lostBound)
  })

  it('RET14: незакрита LOST (межа минула) + окрема активна позика → NULL (активна перекриває все)', async () => {
    const longAgoLost = new Date('2020-01-01T00:00:00.000Z')

    const result = await retainUntilFor(
      new Date('2019-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'LOST', returnedAt: null },
        { id: 'l-2', status: 'HANDED_OVER', returnedAt: null },
      ],
      [{ loanId: 'l-1', type: 'LOAN_LOST', occurredAt: longAgoLost }],
    )

    expect(result).toBeNull()
  })

  it('RET16: LOST закрито (RECOVERED) до спливу 365д → лише closedAt+90д, доданок +365д не рахується', async () => {
    const lostAt = new Date('2026-01-01T00:00:00.000Z')
    const recoveredAt = new Date('2026-01-10T00:00:00.000Z')

    const result = await retainUntilFor(
      new Date('2025-01-01T00:00:00.000Z'),
      [{ id: 'l-1', status: 'LOST', returnedAt: null }],
      [
        { loanId: 'l-1', type: 'LOAN_LOST', occurredAt: lostAt },
        { loanId: 'l-1', type: 'RECOVERED', occurredAt: recoveredAt },
      ],
    )

    expect(result?.getTime()).toBe(recoveredAt.getTime() + RETENTION_CLOSED_WINDOW_MS)
    // Контроль: НЕ дорівнює старій 365-денній межі.
    expect(result?.getTime()).not.toBe(lostAt.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS)
  })

  it('Q3c: closedAt — ПЕРША подія закриття; друга (напр. recover після close_loss) не пересуває момент', async () => {
    const lostAt = new Date('2026-01-01T00:00:00.000Z')
    const closedAt = new Date('2026-01-05T00:00:00.000Z')
    const laterRecoveredAt = new Date('2026-06-01T00:00:00.000Z')

    const result = await retainUntilFor(
      new Date('2025-01-01T00:00:00.000Z'),
      [{ id: 'l-1', status: 'LOST', returnedAt: null }],
      [
        { loanId: 'l-1', type: 'LOAN_LOST', occurredAt: lostAt },
        { loanId: 'l-1', type: 'LOSS_CLOSED', occurredAt: closedAt },
        { loanId: 'l-1', type: 'RECOVERED', occurredAt: laterRecoveredAt },
      ],
    )

    expect(result?.getTime()).toBe(closedAt.getTime() + RETENTION_CLOSED_WINDOW_MS)
  })

  it('RET19: LOST-межа (365д) вже минула, окрема позика щойно RETURNED → returnedAt+90д переважає минулу межу LOST', async () => {
    const longAgoLost = new Date('2020-01-01T00:00:00.000Z') // +365д давно в минулому
    const justReturned = new Date('2026-09-28T00:00:00.000Z')

    const result = await retainUntilFor(
      new Date('2019-01-01T00:00:00.000Z'),
      [
        { id: 'l-1', status: 'LOST', returnedAt: null },
        { id: 'l-2', status: 'RETURNED', returnedAt: justReturned },
      ],
      [{ loanId: 'l-1', type: 'LOAN_LOST', occurredAt: longAgoLost }],
    )

    expect(result?.getTime()).toBe(justReturned.getTime() + RETENTION_CLOSED_WINDOW_MS)
    expect(result!.getTime()).toBeGreaterThan(
      longAgoLost.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS,
    )
  })

  it('RET20: активна позика mark_lost → NULL заміняється НОВОЮ 365д межею щойно втраченої, не старою минулою межею іншої LOST', async () => {
    const longAgoLostB = new Date('2020-01-01T00:00:00.000Z') // давно минула межа
    const justLostA = new Date('2026-09-28T00:00:00.000Z') // щойно

    const result = await retainUntilFor(
      new Date('2019-01-01T00:00:00.000Z'),
      [
        { id: 'l-a', status: 'LOST', returnedAt: null }, // щойно mark_lost
        { id: 'l-b', status: 'LOST', returnedAt: null }, // давня незакрита
      ],
      [
        { loanId: 'l-a', type: 'LOAN_LOST', occurredAt: justLostA },
        { loanId: 'l-b', type: 'LOAN_LOST', occurredAt: longAgoLostB },
      ],
    )

    expect(result?.getTime()).toBe(justLostA.getTime() + RETENTION_UNRESOLVED_LOSS_WINDOW_MS)
  })

  it('цілісність: LOST без LoanEvent LOAN_LOST — падає гучно, а не мовчки видає невірне значення', async () => {
    await expect(
      retainUntilFor(
        new Date('2025-01-01T00:00:00.000Z'),
        [{ id: 'l-1', status: 'LOST', returnedAt: null }],
        [],
      ),
    ).rejects.toThrow(/LOST без LoanEvent LOAN_LOST/)
  })

  it('цілісність: RETURNED без returnedAt — падає гучно', async () => {
    await expect(
      retainUntilFor(
        new Date('2025-01-01T00:00:00.000Z'),
        [{ id: 'l-1', status: 'RETURNED', returnedAt: null }],
        [],
      ),
    ).rejects.toThrow(/RETURNED без returnedAt/)
  })

  it('контакт конкурентно видалений до виклику — мовчки нічого не робить', async () => {
    const client: FakeRetentionClient = {
      externalBorrower: {
        findUnique: () => Promise.resolve(null),
        update: () => {
          throw new Error('не мав викликатись — контакту вже немає')
        },
      },
      loan: { findMany: () => Promise.resolve([]) },
      loanEvent: { findMany: () => Promise.resolve([]) },
    }
    const tx = client as unknown as RetentionTxClient

    await expect(recomputeRetainUntil(tx, 'gone')).resolves.toBeUndefined()
  })
})
