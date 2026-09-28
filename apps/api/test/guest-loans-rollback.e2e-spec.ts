import './helpers/guest-loans-on'
import 'reflect-metadata'
import request from 'supertest'
import { externalBorrowerResponseSchema, guestLoanResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
} from './loan.helpers'
import { LoanEventService } from '../src/loans/loan-event.service'
import { NotificationsService } from '../src/notifications/notifications.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { NewLoanEvent } from '../src/loans/loan-event.types'

/**
 * Stage 10, крок 10f.3 (item 4 рев'ю). Справжні rollback-тести — ін'єкція збою ПІСЛЯ часткового
 * запису (Loan/Copy/відхилення REQUESTED/сповіщення), а не 400-валідація до нього (та лишається
 * окремо в `guest-loans.e2e-spec.ts` і сама по собі rollback не доводить — див. коментар там).
 * Техніка — та сама, що `loans-rollback.e2e-spec.ts`/`loans-recovery-rollback.e2e-spec.ts`:
 * підміна сервісу, що пише останнім у транзакції, так, щоб він кидав.
 */
describe('Stage 10 (10f.3): справжня атомарність (ін’єкція збою, e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const http = (): App => app.getHttpServer()

  async function createContact(account: Account, alias: string): Promise<string> {
    const response = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', account.cookie)
      .send({ alias, ownerInformed: true })
      .expect(201)

    return externalBorrowerResponseSchema.parse(response.body).contact.id
  }

  const createGuestLoan = (account: Account, body: Record<string, unknown>): request.Test =>
    request(http()).post(url('/loans/guest')).set('Cookie', account.cookie).send(body)

  const actOnGuestLoan = (
    account: Account,
    id: string,
    body: Record<string, unknown>,
  ): request.Test =>
    request(http())
      .patch(url(`/loans/guest/${id}`))
      .set('Cookie', account.cookie)
      .send(body)

  describe('Audit (LoanEvent) — збій ПІСЛЯ Loan/Copy/відхилення REQUESTED', () => {
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

    it('збій GUEST_LOAN_RECORDED відкочує Loan, Copy Й відхилення REQUESTED разом', async () => {
      const owner = await registerAccount(app, 'audit-create-owner')
      const rival = await registerAccount(app, 'audit-create-rival')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Audit Create')
      const requested = await requestLoan(app, rival, shelf.copyId).expect(201)
      const rivalLoanId = (requested.body as { loan: { id: string } }).loan.id

      failOn = 'GUEST_LOAN_RECORDED'

      await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(500)

      // Ані гостьового Loan, ані зміни Copy, ані відхиленого rival — усе троє писалося в тій самій
      // транзакції, що й подія, що впала.
      expect(
        await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
      ).toBe(0)
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'AVAILABLE',
      )
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })).status).toBe(
        'REQUESTED',
      )
      expect(await prisma.loanEvent.count({ where: { loan: { copyId: shelf.copyId } } })).toBe(0)

      // Після зняття збою та сама дія проходить — слід не лишився.
      failOn = null
      await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)
    })

    it('збій LOAN_RETURNED відкочує return: Loan/Copy як були, без частково записаного returnedAt', async () => {
      const owner = await registerAccount(app, 'audit-return-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Audit Return')
      const created = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)
      const loanId = guestLoanResponseSchema.parse(created.body).loan.id
      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      failOn = 'LOAN_RETURNED'
      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(500)

      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loanEvent.count({ where: { loanId } })).toBe(1) // лише GUEST_LOAN_RECORDED

      failOn = null
      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)
    })

    it('збій LOAN_LOST відкочує mark_lost: Loan/Copy як були', async () => {
      const owner = await registerAccount(app, 'audit-lost-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Audit Lost')
      const created = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)
      const loanId = guestLoanResponseSchema.parse(created.body).loan.id
      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      failOn = 'LOAN_LOST'
      await actOnGuestLoan(owner, loanId, { action: 'mark_lost' }).expect(500)

      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )

      failOn = null
      await actOnGuestLoan(owner, loanId, { action: 'mark_lost' }).expect(200)
    })

    it('збій RECOVERED відкочує recover: Copy лишається UNAVAILABLE, жодної події не додано', async () => {
      const owner = await registerAccount(app, 'audit-recover-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Audit Recover')
      const created = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)
      const loanId = guestLoanResponseSchema.parse(created.body).loan.id

      await actOnGuestLoan(owner, loanId, { action: 'mark_lost' }).expect(200)

      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      failOn = 'RECOVERED'
      await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(500)

      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loanEvent.findMany({ where: { loanId, type: 'RECOVERED' } })).toEqual([])

      failOn = null
      await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)
    })

    it('збій LOSS_CLOSED відкочує close_loss: жодної події не додано', async () => {
      const owner = await registerAccount(app, 'audit-close-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Audit Close')
      const created = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)
      const loanId = guestLoanResponseSchema.parse(created.body).loan.id

      await actOnGuestLoan(owner, loanId, { action: 'mark_lost' }).expect(200)

      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      failOn = 'LOSS_CLOSED'
      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(500)

      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loanEvent.findMany({ where: { loanId, type: 'LOSS_CLOSED' } })).toEqual(
        [],
      )

      failOn = null
      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
    })
  })

  describe('Сповіщення — збій ПІСЛЯ частини відхилень REQUESTED', () => {
    let failAfter: number
    let calls: number

    beforeAll(async () => {
      app = await createTestApp({
        configure: (builder) => {
          builder.overrideProvider(NotificationsService).useValue({
            create: () => {
              calls += 1

              if (calls > failAfter) {
                return Promise.reject(new Error('Симульований збій запису сповіщення'))
              }

              return Promise.resolve()
            },
            dispatchSoon: () => undefined,
          })
        },
      })
      prisma = app.get(PrismaService)
    })

    beforeEach(() => {
      failAfter = Number.MAX_SAFE_INTEGER
      calls = 0
    })

    afterAll(async () => {
      await app.close()
    })

    it('збій на сповіщенні ДРУГОГО rival відкочує ОБИДВА відхилення, не лише друге', async () => {
      const owner = await registerAccount(app, 'notif-owner')
      const rivalOne = await registerAccount(app, 'notif-rival-one')
      const rivalTwo = await registerAccount(app, 'notif-rival-two')

      await befriend(app, owner, rivalOne)
      await befriend(app, owner, rivalTwo)

      const shelf = await createShelfCopy(app, owner)
      const requestOne = await requestLoan(app, rivalOne, shelf.copyId).expect(201)
      const requestTwo = await requestLoan(app, rivalTwo, shelf.copyId).expect(201)
      const rivalOneId = (requestOne.body as { loan: { id: string } }).loan.id
      const rivalTwoId = (requestTwo.body as { loan: { id: string } }).loan.id

      const contactId = await createContact(owner, 'Гість Notif Fail')

      // Скидаємо лічильник ПІСЛЯ сетапу (два `requestLoan` уже самі викликали `notifications.create`
      // для LOAN_REQUESTED) — рахуємо лише виклики всередині дії під тестом.
      failAfter = 1
      calls = 0

      await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(500)

      // Жоден з двох rival не відхилений — не лише той, на чиєму сповіщенні впало.
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: rivalOneId } })).status).toBe(
        'REQUESTED',
      )
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: rivalTwoId } })).status).toBe(
        'REQUESTED',
      )
      expect(
        await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
      ).toBe(0)
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'AVAILABLE',
      )
      // Жоден guest Loan не створено, тож жодна подія для цього Copy не могла з'явитися.
      expect(await prisma.loanEvent.count({ where: { loan: { copyId: shelf.copyId } } })).toBe(0)
    })
  })

  describe('Синтетичний REQUESTED іншого origin/kind — guest-create його не зачіпає', () => {
    beforeAll(async () => {
      app = await createTestApp()
      prisma = app.get(PrismaService)
    })

    afterAll(async () => {
      await app.close()
    })

    it('origin=RECORDED_EXISTING/borrowerKind=REGISTERED зі status=REQUESTED — синтетичний, не рівнозначний справжньому REQUESTED; guest-create його не чіпає', async () => {
      const owner = await registerAccount(app, 'foreign-synthetic-owner')
      const other = await registerAccount(app, 'foreign-synthetic-other')

      await befriend(app, owner, other)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Foreign Synthetic')

      const synthetic = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: other.id,
          borrowerKind: 'REGISTERED',
          origin: 'RECORDED_EXISTING',
          status: 'REQUESTED',
          requestedAt: null,
          handedAt: null,
        },
      })

      await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)

      const synthAfter = await prisma.loan.findUniqueOrThrow({ where: { id: synthetic.id } })

      expect(synthAfter.status).toBe('REQUESTED')
      expect(synthAfter.respondedAt).toBeNull()
    })
  })
})
