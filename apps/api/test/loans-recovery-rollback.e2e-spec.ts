import 'reflect-metadata'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
} from './loan.helpers'
import { LoanEventService } from '../src/loans/loan-event.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { NewLoanEvent } from '../src/loans/loan-event.types'

/**
 * Stage 10 (10d, T4): подія `LoanEvent` пишеться в тій самій транзакції, що й перехід. Довести це
 * можна лише зламавши запис події й переконавшись, що відкотилося ВСЕ інше (за зразком
 * `loans-rollback.e2e-spec.ts`).
 */
describe('Атомарність LoanEvent (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let failOn: NewLoanEvent['type'] | null

  beforeAll(async () => {
    const real = new LoanEventService()

    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(LoanEventService).useValue({
          record: (tx: Parameters<LoanEventService['record']>[0], event: NewLoanEvent) =>
            event.type === failOn
              ? Promise.reject(new Error('Симульований збій запису LoanEvent'))
              : real.record(tx, event),
        })
      },
    })
    prisma = app.get(PrismaService)
  })

  beforeEach(() => {
    failOn = null
  })

  afterAll(async () => {
    await app.close()
  })

  it('збій запису RECOVERED відкочує зміну Copy: стан і події ті самі', async () => {
    const owner = await registerAccount(app, 'rb-owner')
    const borrower = await registerAccount(app, 'rb-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

    await actOnLoan(app, owner, loanId, { action: 'mark_lost' }).expect(200)

    const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })
    const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

    failOn = 'RECOVERED'
    await actOnLoan(app, owner, loanId, { action: 'recover' }).expect(500)

    expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(copyBefore)
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
    expect((await prisma.loanEvent.findMany({ where: { loanId } })).map((e) => e.type)).toEqual([
      'LOAN_LOST',
    ])

    // Після збою дію можна повторити: слід не лишився.
    failOn = null
    await actOnLoan(app, owner, loanId, { action: 'recover' }).expect(200)
  })

  it('збій запису LOAN_LOST відкочує mark_lost: позика й примірник як були', async () => {
    const owner = await registerAccount(app, 'rb2-owner')
    const borrower = await registerAccount(app, 'rb2-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)
    const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })
    const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

    failOn = 'LOAN_LOST'
    await actOnLoan(app, owner, loanId, { action: 'mark_lost' }).expect(500)

    expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(copyBefore)
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
    expect(await prisma.loanEvent.count({ where: { loanId } })).toBe(0)
  })
})
