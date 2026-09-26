import 'reflect-metadata'
import { loanResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  type Account,
  type Shelf,
} from './loan.helpers'
import { recordedLoan, recordLoan, utcDay } from './recorded.helpers'
import { LoanEventService } from '../src/loans/loan-event.service'
import { NotificationsService } from '../src/notifications/notifications.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10e (§7.3, правило 1; §6.8): запис, подія й сповіщення — в одній транзакції. Збій події чи
 * сповіщення відкочує ВСЕ: жодних часткових змін `Loan`/`Copy`, конкурентних `REQUESTED` і подій.
 */
describe('Stage 10 (10e): атомарність запису наявної позики (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let notificationsFailAfter: number
  let notificationCalls: number
  let eventsFailAfter: number
  let eventCalls: number

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(NotificationsService).useValue({
          create: () => {
            notificationCalls += 1

            return notificationCalls > notificationsFailAfter
              ? Promise.reject(new Error('Симульований збій запису сповіщення'))
              : Promise.resolve()
          },
          dispatchSoon: () => undefined,
        })
        builder.overrideProvider(LoanEventService).useValue({
          record: (tx: PrismaService, event: Parameters<LoanEventService['record']>[1]) => {
            eventCalls += 1

            if (eventCalls > eventsFailAfter) {
              return Promise.reject(new Error('Симульований збій запису події'))
            }

            return new LoanEventService().record(tx, event)
          },
        })
      },
    })
    prisma = app.get(PrismaService)
  })

  beforeEach(() => {
    notificationsFailAfter = Number.MAX_SAFE_INTEGER
    notificationCalls = 0
    eventsFailAfter = Number.MAX_SAFE_INTEGER
    eventCalls = 0
  })

  afterAll(async () => {
    await app.close()
  })

  async function pair(): Promise<{ owner: Account; borrower: Account; shelf: Shelf }> {
    const owner = await registerAccount(app, 'r10er-owner')
    const borrower = await registerAccount(app, 'r10er-borrower')

    await befriend(app, owner, borrower)

    return { owner, borrower, shelf: await createShelfCopy(app, owner) }
  }

  const copyRow = (copyId: string) => prisma.copy.findUniqueOrThrow({ where: { id: copyId } })

  const body = (shelf: Shelf, borrower: Account) => ({
    copyId: shelf.copyId,
    borrowerId: borrower.id,
    handedAt: utcDay(-2),
  })

  it.each([
    ['сповіщення', () => ((notificationsFailAfter = 0), (notificationCalls = 0))],
    ['події RECORD_PROPOSED', () => ((eventsFailAfter = 0), (eventCalls = 0))],
  ])('збій %s при створенні: ані Loan, ані події, примірник вільний', async (_name, breakIt) => {
    const { owner, borrower, shelf } = await pair()

    breakIt()

    await recordLoan(app, owner, body(shelf, borrower)).expect(500)

    expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)

    const copy = await copyRow(shelf.copyId)

    expect(copy.status).toBe('AVAILABLE')
    expect(copy.currentHolderId).toBe(owner.id)
  })

  it('збій події при створенні не лишає LoanEvent для цього примірника', async () => {
    const { owner, borrower, shelf } = await pair()

    eventsFailAfter = 0
    eventCalls = 0
    await recordLoan(app, owner, body(shelf, borrower)).expect(500)

    expect(await prisma.loanEvent.count({ where: { loan: { copyId: shelf.copyId } } })).toBe(0)
  })

  it.each([
    ['confirm_record', 'borrower'],
    ['decline_record', 'borrower'],
    ['withdraw_record', 'owner'],
    ['amend_record', 'owner'],
  ] as const)('збій сповіщення на %s відкочує перехід', async (action, side) => {
    const { owner, borrower, shelf } = await pair()
    const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
    const before = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })

    notificationsFailAfter = 0
    notificationCalls = 0

    await actOnLoan(app, side === 'owner' ? owner : borrower, loan.id, {
      action,
      ...(action === 'amend_record' ? { dueAt: utcDay(9) } : {}),
    }).expect(500)

    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(before)

    const copy = await copyRow(shelf.copyId)

    expect([copy.status, copy.currentHolderId]).toEqual(['RESERVED', owner.id])
    expect(
      (await prisma.loanEvent.findMany({ where: { loanId: loan.id } })).map((event) => event.type),
    ).toEqual(['RECORD_PROPOSED'])
  })

  it('збій сповіщення й події при очищенні строку (dueAt: null) відкочує зміну', async () => {
    const { owner, borrower, shelf } = await pair()
    const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
    const before = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })

    notificationsFailAfter = 0
    notificationCalls = 0
    await actOnLoan(app, owner, loan.id, { action: 'amend_record', dueAt: null }).expect(500)
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(before)

    notificationsFailAfter = Number.MAX_SAFE_INTEGER
    eventsFailAfter = eventCalls
    await actOnLoan(app, owner, loan.id, { action: 'amend_record', dueAt: null }).expect(500)

    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(before)
    expect(
      (await prisma.loanEvent.findMany({ where: { loanId: loan.id } })).map((event) => event.type),
    ).toEqual(['RECORD_PROPOSED'])
  })

  it.each(['confirm_record', 'amend_record'] as const)(
    'збій події на %s відкочує зміну Loan/Copy',
    async (action) => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
      const before = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })

      eventsFailAfter = eventCalls
      await actOnLoan(app, action === 'confirm_record' ? borrower : owner, loan.id, {
        action,
        ...(action === 'amend_record' ? { dueAt: utcDay(9) } : {}),
      }).expect(500)

      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(before)
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')
    },
  )

  it('збій сповіщення конкуренту при confirm_record відкочує підтвердження й відхилення REQUESTED', async () => {
    const { owner, borrower, shelf } = await pair()
    const rival = await registerAccount(app, 'r10er-rival')

    await befriend(app, owner, rival)

    const created = await requestLoan(app, rival, shelf.copyId).expect(201)
    const rivalId = loanResponseSchema.parse(created.body).loan.id
    const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

    // Перше сповіщення (власнику про підтвердження) проходить, друге (конкуренту) падає.
    notificationsFailAfter = 1
    notificationCalls = 0

    await actOnLoan(app, borrower, loan.id, { action: 'confirm_record' }).expect(500)

    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe(
      'PENDING_CONFIRMATION',
    )
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: rivalId } })).status).toBe(
      'REQUESTED',
    )

    const copy = await copyRow(shelf.copyId)

    expect([copy.status, copy.currentHolderId]).toEqual(['RESERVED', owner.id])
    expect(
      (await prisma.loanEvent.findMany({ where: { loanId: loan.id } })).map((event) => event.type),
    ).toEqual(['RECORD_PROPOSED'])
  })
})
