import 'reflect-metadata'
import request from 'supertest'
import { Client } from 'pg'
import { API_ERROR_CODES, apiErrorSchema, loanResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { beginRequest, waitForBlockedBackend } from './concurrency.helpers'
import { testDatabaseUrl } from './db/test-database'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { recordedLoan, recordLoan, utcDay } from './recorded.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { Response } from 'supertest'

/**
 * Stage 10, крок 10e (§9.1, C1–C4, C10): конкурентні сценарії запису наявної позики.
 *
 * Гонка влаштовується примусово, як у `loans-concurrency.e2e-spec.ts`: окрема сесія тримає лок на `Copy`,
 * усі запити гарантовано стають у чергу (перевіряється `pg_stat_activity`), і лише потім лок відпускається.
 */
describe('Stage 10 (10e): конкуренція запису наявної позики (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let sessions: Client[]
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  beforeEach(() => {
    sessions = []
  })

  afterEach(async () => {
    await Promise.allSettled(
      sessions.map(async (session) => {
        await session.query('ROLLBACK').catch(() => undefined)
        await session.end()
      }),
    )
  })

  afterAll(async () => {
    await app.close()
  })

  const codeOf = (response: Response): string => apiErrorSchema.parse(response.body).code
  const statuses = (responses: Response[]): number[] =>
    responses.map((response) => response.status).sort()

  /** Тримає лок `Copy`, ставить у чергу всі запити, відпускає й повертає їхні відповіді. */
  async function raceUnderLock(copyId: string, tests: request.Test[]): Promise<Response[]> {
    const holder = new Client({ connectionString: testDatabaseUrl() })

    await holder.connect()
    sessions.push(holder)
    await holder.query('BEGIN')
    await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [copyId])

    const pending = tests.map((test) => beginRequest(test))

    await waitForBlockedBackend(prisma, { expectedCount: tests.length })
    await holder.query('COMMIT')

    return Promise.all(pending)
  }

  async function setup(friends = 1): Promise<{ owner: Account; others: Account[]; shelf: Shelf }> {
    const owner = await registerAccount(app, 'r10ec-owner')
    const others: Account[] = []

    for (let index = 0; index < friends; index += 1) {
      const other = await registerAccount(app, `r10ec-friend-${String(index)}`)

      await befriend(app, owner, other)
      others.push(other)
    }

    return { owner, others, shelf: await createShelfCopy(app, owner) }
  }

  const exclusiveCount = (copyId: string) =>
    prisma.loan.count({
      where: { copyId, status: { in: ['APPROVED', 'HANDED_OVER', 'PENDING_CONFIRMATION'] } },
    })

  const body = (copyId: string, borrower: Account) => ({
    copyId,
    borrowerId: borrower.id,
    handedAt: utcDay(-3),
  })

  it('C1: два одночасні записи на один примірник → один 201, другий 409 LOAN_COPY_UNAVAILABLE', async () => {
    const {
      owner,
      others: [first, second],
      shelf,
    } = await setup(2)

    if (first === undefined || second === undefined) throw new Error('Очікувалось двоє друзів')

    const responses = await raceUnderLock(shelf.copyId, [
      recordLoan(app, owner, body(shelf.copyId, first)),
      recordLoan(app, owner, body(shelf.copyId, second)),
    ])

    expect(statuses(responses)).toEqual([201, 409])

    const loser = responses.find((response) => response.status === 409)

    expect(loser === undefined ? '' : codeOf(loser)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)
    expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(1)
    expect(await exclusiveCount(shelf.copyId)).toBe(1)
    expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
      'RESERVED',
    )
  })

  it('C2: запис ∥ апрув чужого REQUESTED → рівно один переможець; запис сам конкурентів не відхиляє', async () => {
    const {
      owner,
      others: [requester, borrower],
      shelf,
    } = await setup(2)

    if (requester === undefined || borrower === undefined)
      throw new Error('Очікувалось двоє друзів')

    const created = await requestLoan(app, requester, shelf.copyId).expect(201)
    const rivalId = loanResponseSchema.parse(created.body).loan.id

    const [recordResponse, approveResponse] = await raceUnderLock(shelf.copyId, [
      recordLoan(app, owner, body(shelf.copyId, borrower)),
      actOnLoan(app, owner, rivalId, { action: 'approve' }),
    ])

    if (recordResponse === undefined || approveResponse === undefined)
      throw new Error('Немає відповідей')

    // Рівно один переміг: або запис (201) + відмова апруву (409), або апрув (200) + відмова запису (409).
    expect([
      [201, 409],
      [200, 409],
    ]).toContainEqual(statuses([recordResponse, approveResponse]))
    expect(await exclusiveCount(shelf.copyId)).toBe(1)

    const rival = await prisma.loan.findUniqueOrThrow({ where: { id: rivalId } })

    if (recordResponse.status === 201) {
      // Запис виграв: апрув відмовив, а REQUESTED лишився чинним (його не відхиляє сам запис).
      expect(approveResponse.status).toBe(409)
      expect(rival.status).toBe('REQUESTED')
    } else {
      // Апрув виграв: запис відмовив, примірник під апрувом.
      expect(recordResponse.status).toBe(409)
      expect(rival.status).toBe('APPROVED')
    }
  })

  it('C3: confirm ∥ withdraw → один результат і узгоджений стан примірника', async () => {
    const {
      owner,
      others: [borrower],
      shelf,
    } = await setup(1)

    if (borrower === undefined) throw new Error('Очікувався друг')

    const loan = await recordedLoan(app, owner, borrower, shelf.copyId)
    const responses = await raceUnderLock(shelf.copyId, [
      actOnLoan(app, borrower, loan.id, { action: 'confirm_record' }),
      actOnLoan(app, owner, loan.id, { action: 'withdraw_record' }),
    ])

    expect(statuses(responses)).toEqual([200, 409])

    const [confirmResponse] = responses
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

    if (confirmResponse?.status === 200) {
      expect([row.status, copy.status, copy.currentHolderId]).toEqual([
        'HANDED_OVER',
        'LENT_OUT',
        borrower.id,
      ])
    } else {
      expect([row.status, copy.status, copy.currentHolderId]).toEqual([
        'CANCELLED',
        'AVAILABLE',
        owner.id,
      ])
    }

    const types = (await prisma.loanEvent.findMany({ where: { loanId: loan.id } })).map(
      (event) => event.type,
    )

    expect(types.filter((type) => type !== 'RECORD_PROPOSED')).toHaveLength(1)
  })

  it('C3b: confirm ∥ amend → до підтвердження дати можна змінити, після — ні; стан узгоджений', async () => {
    const {
      owner,
      others: [borrower],
      shelf,
    } = await setup(1)

    if (borrower === undefined) throw new Error('Очікувався друг')

    const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
    const responses = await raceUnderLock(shelf.copyId, [
      actOnLoan(app, borrower, loan.id, { action: 'confirm_record' }),
      actOnLoan(app, owner, loan.id, { action: 'amend_record', dueAt: utcDay(9) }),
    ])
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    const [confirmResponse, amendResponse] = responses

    // Підтвердження завжди проходить; правка або встигла ДО нього (200), або відмовила після (409).
    expect(confirmResponse?.status).toBe(200)
    expect(row.status).toBe('HANDED_OVER')
    expect([200, 409]).toContain(amendResponse?.status)

    const amended = amendResponse?.status === 200

    expect(row.dueAt?.toISOString().slice(0, 10)).toBe(amended ? utcDay(9) : utcDay(5))
  })

  it('C3c (Q23): confirm ∥ очищення строку → правка або до confirm, або відхилена після нього; стан і події узгоджені', async () => {
    const {
      owner,
      others: [borrower],
      shelf,
    } = await setup(1)

    if (borrower === undefined) throw new Error('Очікувався друг')

    const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
    const responses = await raceUnderLock(shelf.copyId, [
      actOnLoan(app, borrower, loan.id, { action: 'confirm_record' }),
      actOnLoan(app, owner, loan.id, { action: 'amend_record', dueAt: null }),
    ])
    const row = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    const [confirmResponse, amendResponse] = responses

    // Підтвердження завжди проходить; правка або встигла ДО нього (200), або відмовила після (409).
    expect(confirmResponse?.status).toBe(200)
    expect(row.status).toBe('HANDED_OVER')
    expect([200, 409]).toContain(amendResponse?.status)

    const amended = amendResponse?.status === 200

    const amendEvents = await prisma.loanEvent.count({
      where: { loanId: loan.id, type: 'RECORD_AMENDED' },
    })

    expect(amendEvents).toBe(amended ? 1 : 0)
    expect(row.dueAt === null ? null : row.dueAt.toISOString().slice(0, 10)).toBe(
      amended ? null : utcDay(5),
    )
  })

  it.each([
    [
      'архівування',
      (owner: Account, shelf: Shelf) =>
        request(http())
          .post(url(`/me/library/${shelf.copyId}/archive`))
          .set('Cookie', owner.cookie),
    ],
    [
      'видалення',
      (owner: Account, shelf: Shelf) =>
        request(http())
          .delete(url(`/me/library/${shelf.copyId}`))
          .set('Cookie', owner.cookie),
    ],
  ] as const)('C4: запис ∥ %s → без осиротілих станів', async (_name, makeRequest) => {
    const {
      owner,
      others: [borrower],
      shelf,
    } = await setup(1)

    if (borrower === undefined) throw new Error('Очікувався друг')

    const [recordResponse, removalResponse] = await raceUnderLock(shelf.copyId, [
      recordLoan(app, owner, body(shelf.copyId, borrower)),
      makeRequest(owner, shelf),
    ])

    if (recordResponse === undefined || removalResponse === undefined)
      throw new Error('Немає відповідей')

    const copy = await prisma.copy.findUnique({ where: { id: shelf.copyId } })
    const loans = await prisma.loan.count({ where: { copyId: shelf.copyId } })

    if (recordResponse.status === 201) {
      // Запис устиг: примірник живий, не архівний, зарезервований; архів/видалення відмовили (409).
      expect(removalResponse.status).toBe(409)
      expect(copy?.archivedAt).toBeNull()
      expect(copy?.status).toBe('RESERVED')
      expect(loans).toBe(1)
    } else {
      // Архів/видалення устигли: запису немає, жодного `Loan` без примірника.
      expect([200, 204]).toContain(removalResponse.status)
      expect([404, 409]).toContain(recordResponse.status)
      expect(loans).toBe(0)
    }
  })

  it('C10: confirm ∥ cancel чужого REQUESTED → узгоджено, без висячих REQUESTED на LENT_OUT', async () => {
    const {
      owner,
      others: [borrower, rival],
      shelf,
    } = await setup(2)

    if (borrower === undefined || rival === undefined) throw new Error('Очікувалось двоє друзів')

    const created = await requestLoan(app, rival, shelf.copyId).expect(201)
    const rivalId = loanResponseSchema.parse(created.body).loan.id
    const loan = await recordedLoan(app, owner, borrower, shelf.copyId)
    const [confirmResponse, cancelResponse] = await raceUnderLock(shelf.copyId, [
      actOnLoan(app, borrower, loan.id, { action: 'confirm_record' }),
      actOnLoan(app, rival, rivalId, { action: 'cancel' }),
    ])

    expect(confirmResponse?.status).toBe(200)
    // Або скасування встигло (200), або confirm уже відхилив запит (409, LOAN_INVALID_TRANSITION).
    expect([200, 409]).toContain(cancelResponse?.status)

    const rivalRow = await prisma.loan.findUniqueOrThrow({ where: { id: rivalId } })

    expect(rivalRow.status).toBe(cancelResponse?.status === 200 ? 'CANCELLED' : 'REJECTED')
    expect(await prisma.loan.count({ where: { copyId: shelf.copyId, status: 'REQUESTED' } })).toBe(
      0,
    )
    expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
      'LENT_OUT',
    )
  })

  it('сторонній: запит на чужий Copy → 404 ДО звільнення чужого лока (не стає в чергу)', async () => {
    const {
      owner,
      others: [friend],
      shelf,
    } = await setup(1)
    const stranger = await registerAccount(app, 'r10ec-stranger')

    if (friend === undefined) throw new Error('Очікувався друг')

    await befriend(app, stranger, friend)

    const holder = new Client({ connectionString: testDatabaseUrl() })

    await holder.connect()
    sessions.push(holder)
    await holder.query('BEGIN')
    await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

    // Лок утримує інша транзакція. Якби сервіс спершу брав лок, а потім перевіряв власника, запит
    // стороннього завис би до COMMIT нижче — і цей `await` не завершився б (тест впав би за таймаутом).
    const strangerResponse = await recordLoan(app, stranger, body(shelf.copyId, friend))
    const missingResponse = await recordLoan(app, stranger, body('no-such-copy', friend))

    expect(strangerResponse.status).toBe(404)
    expect(missingResponse.status).toBe(404)

    // Доказ, що лок досі утримується саме в момент відповіді: власник справді стає в чергу.
    const ownerRequest = beginRequest(recordLoan(app, owner, body(shelf.copyId, friend)))

    await waitForBlockedBackend(prisma, { expectedCount: 1 })
    await holder.query('COMMIT')

    expect((await ownerRequest).status).toBe(201)
    expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(1)
  })
})
