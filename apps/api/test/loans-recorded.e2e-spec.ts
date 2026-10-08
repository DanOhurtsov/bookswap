import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  copyHistoryResponseSchema,
  loanListResponseSchema,
  loanResponseSchema,
  workHistoryResponseSchema,
  workHoldersResponseSchema,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
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
import { NotificationDigestService } from '../src/notifications/notification-digest.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { NotificationType } from '../src/generated/prisma/enums'

/**
 * Stage 10, крок 10e (docs/plan/stage-10-real-world-history.md, §6.2–§6.3, E1–E8, C6–C9, Q6, Q12):
 * запис уже активної позики між зареєстрованими друзями.
 */
describe('Stage 10 (10e): запис наявної позики (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let digest: NotificationDigestService
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    digest = app.get(NotificationDigestService)
  })

  afterAll(async () => {
    await app.close()
  })

  const errorCode = (body: unknown): string => apiErrorSchema.parse(body).code

  async function pair(): Promise<{ owner: Account; borrower: Account; shelf: Shelf }> {
    const owner = await registerAccount(app, 'r10e-owner')
    const borrower = await registerAccount(app, 'r10e-borrower')

    await befriend(app, owner, borrower)

    return { owner, borrower, shelf: await createShelfCopy(app, owner) }
  }

  const copyRow = (copyId: string) => prisma.copy.findUniqueOrThrow({ where: { id: copyId } })
  const loanRow = (loanId: string) => prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
  const eventsOf = (loanId: string) =>
    prisma.loanEvent.findMany({ where: { loanId }, orderBy: { occurredAt: 'asc' } })
  const notificationsOf = (userId: string, type: NotificationType, loanId?: string) =>
    prisma.notification.findMany({
      where: {
        userId,
        type,
        ...(loanId === undefined ? {} : { payload: { path: ['loanId'], equals: loanId } }),
      },
    })

  function act(actor: Account, loanId: string, body: Record<string, unknown>): request.Test {
    return actOnLoan(app, actor, loanId, body)
  }

  async function expectUntouched(shelf: Shelf, owner: Account): Promise<void> {
    expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)

    const copy = await copyRow(shelf.copyId)

    expect(copy.status).toBe('AVAILABLE')
    expect(copy.currentHolderId).toBe(owner.id)
  }

  // ---------------------------------------------------------------------------------------------
  describe('E1: POST /loans/recorded', () => {
    it('створює PENDING_CONFIRMATION без запиту, резервує примірник, пише подію й сповіщення', async () => {
      const { owner, borrower, shelf } = await pair()
      const before = Date.now()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })

      expect(loan.status).toBe('PENDING_CONFIRMATION')
      expect(loan.origin).toBe('RECORDED_EXISTING')
      expect(loan.requestedAt).toBeNull()
      expect(loan.respondedAt).toBeNull()
      expect(loan.handedAt).toBe(`${utcDay(-10)}T00:00:00.000Z`)
      expect(loan.dueAt).toBe(utcDay(5))
      expect(Date.parse(loan.createdAt)).toBeGreaterThanOrEqual(before - 1000)
      expect(loan.owner.id).toBe(owner.id)
      expect(loan.borrower.id).toBe(borrower.id)
      expect(loan.copy.status).toBe('RESERVED')

      const row = await loanRow(loan.id)

      expect(row.requestedAt).toBeNull()
      expect(row.borrowerKind).toBe('REGISTERED')

      const copy = await copyRow(shelf.copyId)

      expect(copy.status).toBe('RESERVED')
      expect(copy.currentHolderId).toBe(owner.id)

      const events = await eventsOf(loan.id)

      expect(events.map((event) => event.type)).toEqual(['RECORD_PROPOSED'])
      expect(events[0]?.actorId).toBe(owner.id)
      expect(events[0]?.payload).toEqual({ handedOn: utcDay(-10), dueOn: utcDay(5) })

      expect(await notificationsOf(borrower.id, 'LOAN_RECORD_PROPOSED', loan.id)).toHaveLength(1)
      expect(await notificationsOf(owner.id, 'LOAN_RECORD_PROPOSED', loan.id)).toHaveLength(0)
    })

    it('без dueAt; handedAt = сьогодні допустимий; жодних LOAN_REQUESTED/LOAN_APPROVED (D6)', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { handedAt: utcDay() })

      expect(loan.dueAt).toBeNull()

      for (const type of ['LOAN_REQUESTED', 'LOAN_APPROVED'] as const) {
        expect(await notificationsOf(owner.id, type, loan.id)).toHaveLength(0)
        expect(await notificationsOf(borrower.id, type, loan.id)).toHaveLength(0)
      }

      // Аналітика: лише LOAN_RECORDED (subject — власник); жодних кроків core loop.
      const events = await prisma.productEvent.findMany({
        where: {
          subjectUserId: { in: [owner.id, borrower.id] },
          type: { startsWith: 'LOAN_' },
        },
      })

      expect(events.map((event) => event.type)).toEqual(['LOAN_RECORDED'])
      expect(events[0]?.subjectUserId).toBe(owner.id)
    })

    it('GET /loans і GET /loans/:id віддають запис обом сторонам; requestedAt = null', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      for (const account of [owner, borrower]) {
        const one = await request(http())
          .get(url(`/loans/${loan.id}`))
          .set('Cookie', account.cookie)
          .expect(200)

        expect(loanResponseSchema.parse(one.body).loan.requestedAt).toBeNull()

        const list = await request(http())
          .get(url('/loans'))
          .set('Cookie', account.cookie)
          .expect(200)

        expect(loanListResponseSchema.parse(list.body).loans.map((item) => item.id)).toContain(
          loan.id,
        )
      }

      const filtered = await request(http())
        .get(url('/loans?role=borrower&status=PENDING_CONFIRMATION'))
        .set('Cookie', borrower.cookie)
        .expect(200)

      expect(loanListResponseSchema.parse(filtered.body).loans.map((item) => item.id)).toEqual([
        loan.id,
      ])
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('E5: негативні сценарії створення (жодних часткових змін)', () => {
    it('не друг → 403 FORBIDDEN; невідомий користувач — так само', async () => {
      const owner = await registerAccount(app, 'r10e-nf-owner')
      const stranger = await registerAccount(app, 'r10e-nf-stranger')
      const shelf = await createShelfCopy(app, owner)

      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: stranger.id,
        handedAt: utcDay(-1),
      }).expect(403)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.FORBIDDEN)

      await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: 'no-such-user',
        handedAt: utcDay(-1),
      }).expect(403)
      await expectUntouched(shelf, owner)
    })

    it('заблокована пара → 403 FRIENDSHIP_BLOCKED', async () => {
      const { owner, borrower, shelf } = await pair()

      await request(http())
        .post(url(`/friends/${borrower.id}/block`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: borrower.id,
        handedAt: utcDay(-1),
      }).expect(403)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.FRIENDSHIP_BLOCKED)
      await expectUntouched(shelf, owner)
    })

    it('сам собі → 400 LOAN_SELF', async () => {
      const owner = await registerAccount(app, 'r10e-self')
      const shelf = await createShelfCopy(app, owner)
      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: owner.id,
        handedAt: utcDay(-1),
      }).expect(400)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_SELF)
      await expectUntouched(shelf, owner)
    })

    it.each([
      ['handedAt у майбутньому', () => ({ handedAt: utcDay(1) })],
      ['handedAt далеко в майбутньому', () => ({ handedAt: '2999-01-01' })],
      ['dueAt раніше за день передачі', () => ({ handedAt: utcDay(-3), dueAt: utcDay(-4) })],
    ])('%s → 400 LOAN_RECORD_DATE_INVALID', async (_name, dates) => {
      const { owner, borrower, shelf } = await pair()
      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: borrower.id,
        ...dates(),
      }).expect(400)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_RECORD_DATE_INVALID)
      await expectUntouched(shelf, owner)
    })

    it('dueAt = день передачі допустимий', async () => {
      const { owner, borrower, shelf } = await pair()

      await recordedLoan(app, owner, borrower, shelf.copyId, {
        handedAt: utcDay(-3),
        dueAt: utcDay(-3),
      })
    })

    it.each([
      ['без handedAt', { copyId: 'x', borrowerId: 'y' }],
      ['зіпсована дата', { copyId: 'x', borrowerId: 'y', handedAt: 'вчора' }],
      [
        'зайве поле message',
        { copyId: 'x', borrowerId: 'y', handedAt: '2026-01-01', message: 'hi' },
      ],
      ['без borrowerId', { copyId: 'x', handedAt: '2026-01-01' }],
    ])('невалідне тіло (%s) → 400 VALIDATION_ERROR', async (_name, body) => {
      const owner = await registerAccount(app, 'r10e-val')
      const response = await recordLoan(app, owner, body).expect(400)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('примірник не вільний: RESERVED, UNAVAILABLE, LENT_OUT → 409 LOAN_COPY_UNAVAILABLE', async () => {
      const { owner, borrower, shelf } = await pair()
      const second = await registerAccount(app, 'r10e-busy-2')

      await befriend(app, owner, second)

      // UNAVAILABLE («тимчасово не даю»).
      await request(http())
        .patch(url(`/me/library/${shelf.copyId}`))
        .set('Cookie', owner.cookie)
        .send({ status: 'UNAVAILABLE' })
        .expect(200)

      const unavailable = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: borrower.id,
        handedAt: utcDay(-1),
      }).expect(409)

      expect(errorCode(unavailable.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)

      await request(http())
        .patch(url(`/me/library/${shelf.copyId}`))
        .set('Cookie', owner.cookie)
        .send({ status: 'AVAILABLE' })
        .expect(200)

      // RESERVED — вже є запис.
      await recordedLoan(app, owner, borrower, shelf.copyId)

      const reserved = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: second.id,
        handedAt: utcDay(-1),
      }).expect(409)

      expect(errorCode(reserved.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(1)
    })

    it('LENT_OUT (підтверджена позика) → 409 LOAN_COPY_UNAVAILABLE', async () => {
      const { owner, borrower, shelf } = await pair()
      const second = await registerAccount(app, 'r10e-lent-2')

      await befriend(app, owner, second)

      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: second.id,
        handedAt: utcDay(-1),
      }).expect(409)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)
    })

    it('архівний примірник → 409 COPY_ARCHIVED', async () => {
      const { owner, borrower, shelf } = await pair()

      await request(http())
        .post(url(`/me/library/${shelf.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const response = await recordLoan(app, owner, {
        copyId: shelf.copyId,
        borrowerId: borrower.id,
        handedAt: utcDay(-1),
      }).expect(409)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.COPY_ARCHIVED)
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)
    })

    it('чужий і неіснуючий примірник → 404; без сесії → 401', async () => {
      const { owner, borrower, shelf } = await pair()
      const other = await registerAccount(app, 'r10e-other')

      await befriend(app, other, borrower)

      await recordLoan(app, other, {
        copyId: shelf.copyId,
        borrowerId: borrower.id,
        handedAt: utcDay(-1),
      }).expect(404)
      await recordLoan(app, owner, {
        copyId: 'no-such-copy',
        borrowerId: borrower.id,
        handedAt: utcDay(-1),
      }).expect(404)
      await request(http())
        .post(url('/loans/recorded'))
        .send({ copyId: shelf.copyId, borrowerId: borrower.id, handedAt: utcDay(-1) })
        .expect(401)
      await expectUntouched(shelf, owner)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('E2: confirm_record', () => {
    it('HANDED_OVER, LENT_OUT у позичальника, handedAt не перезаписано, подія й сповіщення власнику', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(20) })
      const response = await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)
      const confirmed = loanResponseSchema.parse(response.body).loan

      expect(confirmed.status).toBe('HANDED_OVER')
      expect(confirmed.handedAt).toBe(loan.handedAt)
      expect(confirmed.requestedAt).toBeNull()
      expect(confirmed.respondedAt).toBeNull()
      expect(confirmed.copy.status).toBe('LENT_OUT')

      const copy = await copyRow(shelf.copyId)

      expect(copy.status).toBe('LENT_OUT')
      expect(copy.currentHolderId).toBe(borrower.id)
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_CONFIRMED',
      ])
      expect(await notificationsOf(owner.id, 'LOAN_RECORD_CONFIRMED', loan.id)).toHaveLength(1)

      // Аналітика запису — окремі події; кроки core loop (LOAN_HANDED_OVER) для записаних не пишуться.
      const types = (
        await prisma.productEvent.findMany({
          where: {
            subjectUserId: { in: [owner.id, borrower.id] },
            type: { startsWith: 'LOAN_' },
          },
        })
      ).map((event) => event.type)

      expect(types.sort()).toEqual(['LOAN_RECORDED', 'LOAN_RECORD_CONFIRMED'])
    })

    it('повторне підтвердження → 409 LOAN_INVALID_TRANSITION', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      const again = await act(borrower, loan.id, { action: 'confirm_record' }).expect(409)

      expect(errorCode(again.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
    })
  })

  describe('E3: decline_record', () => {
    it('DECLINED, Copy AVAILABLE вдома, Loan і події збережені, сповіщення власнику', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)
      const response = await act(borrower, loan.id, { action: 'decline_record' }).expect(200)

      expect(loanResponseSchema.parse(response.body).loan.status).toBe('DECLINED')

      const copy = await copyRow(shelf.copyId)

      expect(copy.status).toBe('AVAILABLE')
      expect(copy.currentHolderId).toBe(owner.id)
      expect((await loanRow(loan.id)).handedAt).not.toBeNull()
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_DECLINED',
      ])
      expect(await notificationsOf(owner.id, 'LOAN_RECORD_DECLINED', loan.id)).toHaveLength(1)
    })

    it('після відмови можна записати заново — новий Loan', async () => {
      const { owner, borrower, shelf } = await pair()
      const first = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(borrower, first.id, { action: 'decline_record' }).expect(200)

      const second = await recordedLoan(app, owner, borrower, shelf.copyId)

      expect(second.id).not.toBe(first.id)
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(2)
    })
  })

  describe('E4: withdraw_record і amend_record (Q12)', () => {
    it('withdraw: CANCELLED, Copy AVAILABLE, сповіщення позичальнику, подія', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)
      const response = await act(owner, loan.id, { action: 'withdraw_record' }).expect(200)

      expect(loanResponseSchema.parse(response.body).loan.status).toBe('CANCELLED')
      expect((await copyRow(shelf.copyId)).status).toBe('AVAILABLE')
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_WITHDRAWN',
      ])
      expect(await notificationsOf(borrower.id, 'LOAN_RECORD_WITHDRAWN', loan.id)).toHaveLength(1)
    })

    it('amend: змінює лише handedAt/dueAt, подія з попередніми й новими значеннями, сповіщення', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
      const response = await act(owner, loan.id, {
        action: 'amend_record',
        handedAt: utcDay(-8),
        dueAt: utcDay(9),
      }).expect(200)
      const amended = loanResponseSchema.parse(response.body).loan

      expect(amended.status).toBe('PENDING_CONFIRMATION')
      expect(amended.handedAt).toBe(`${utcDay(-8)}T00:00:00.000Z`)
      expect(amended.dueAt).toBe(utcDay(9))
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')

      const events = await eventsOf(loan.id)

      expect(events.map((event) => event.type)).toEqual(['RECORD_PROPOSED', 'RECORD_AMENDED'])
      expect(events[1]?.payload).toEqual({
        previous: { handedOn: utcDay(-10), dueOn: utcDay(5) },
        next: { handedOn: utcDay(-8), dueOn: utcDay(9) },
      })
      expect(await notificationsOf(borrower.id, 'LOAN_RECORD_AMENDED', loan.id)).toHaveLength(1)

      // Лише dueAt — handedAt лишається.
      const onlyDue = await act(owner, loan.id, {
        action: 'amend_record',
        dueAt: utcDay(12),
      }).expect(200)

      expect(loanResponseSchema.parse(onlyDue.body).loan.handedAt).toBe(
        `${utcDay(-8)}T00:00:00.000Z`,
      )
    })

    it('Q23: dueAt null прибирає строк; omitted не змінює; повторне очищення — 400 без подій і сповіщень; audit зберігає previous → null', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })

      // omitted: змінюється лише handedAt, строк лишається.
      const kept = await act(owner, loan.id, {
        action: 'amend_record',
        handedAt: utcDay(-9),
      }).expect(200)

      expect(loanResponseSchema.parse(kept.body).loan.dueAt).toBe(utcDay(5))

      // null: строк прибрано, дата передачі не змінилась.
      const cleared = await act(owner, loan.id, { action: 'amend_record', dueAt: null }).expect(200)
      const clearedLoan = loanResponseSchema.parse(cleared.body).loan

      expect(clearedLoan.dueAt).toBeNull()
      expect(clearedLoan.handedAt).toBe(`${utcDay(-9)}T00:00:00.000Z`)
      expect((await loanRow(loan.id)).dueAt).toBeNull()
      expect(clearedLoan.status).toBe('PENDING_CONFIRMATION')
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')

      const amended = (await eventsOf(loan.id)).filter((event) => event.type === 'RECORD_AMENDED')

      expect(amended).toHaveLength(2)
      expect(amended[1]?.payload).toEqual({
        previous: { handedOn: utcDay(-9), dueOn: utcDay(5) },
        next: { handedOn: utcDay(-9), dueOn: null },
      })

      // повторне очищення — no-op: чинна відмова, жодних нових подій і сповіщень.
      const notificationsBefore = await notificationsOf(borrower.id, 'LOAN_RECORD_AMENDED', loan.id)
      const again = await act(owner, loan.id, { action: 'amend_record', dueAt: null }).expect(400)

      expect(errorCode(again.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect(
        (await eventsOf(loan.id)).filter((event) => event.type === 'RECORD_AMENDED'),
      ).toHaveLength(2)
      expect(await notificationsOf(borrower.id, 'LOAN_RECORD_AMENDED', loan.id)).toHaveLength(
        notificationsBefore.length,
      )

      // строк можна задати знову, а null у payload з null → дата
      await act(owner, loan.id, { action: 'amend_record', dueAt: utcDay(7) }).expect(200)

      const last = (await eventsOf(loan.id)).filter((event) => event.type === 'RECORD_AMENDED')[2]

      expect(last?.payload).toMatchObject({
        previous: { dueOn: null },
        next: { dueOn: utcDay(7) },
      })
    })

    it('Q23: очищення без строку від початку → 400; нова дата передачі + null разом; null поза amend_record → 400', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(owner, loan.id, { action: 'amend_record', dueAt: null }).expect(400)

      const withDue = await recordedLoan(
        app,
        owner,
        borrower,
        (await createShelfCopy(app, owner)).copyId,
        {
          dueAt: utcDay(5),
        },
      )
      const both = await act(owner, withDue.id, {
        action: 'amend_record',
        handedAt: utcDay(-4),
        dueAt: null,
      }).expect(200)

      expect(loanResponseSchema.parse(both.body).loan.dueAt).toBeNull()

      for (const [actor, action] of [
        [owner, 'approve'],
        [owner, 'withdraw_record'],
        [borrower, 'confirm_record'],
      ] as const) {
        const response = await act(actor, loan.id, { action, dueAt: null }).expect(400)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }

      expect((await loanRow(loan.id)).status).toBe('PENDING_CONFIRMATION')
    })

    it('Q23: позичальник не очищає строк (403); після підтвердження очищення → 409, строк збережено', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
      const forbidden = await act(borrower, loan.id, {
        action: 'amend_record',
        dueAt: null,
      }).expect(403)

      expect(errorCode(forbidden.body)).toBe(API_ERROR_CODES.FORBIDDEN)
      expect((await loanRow(loan.id)).dueAt).not.toBeNull()

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      const late = await act(owner, loan.id, { action: 'amend_record', dueAt: null }).expect(409)

      expect(errorCode(late.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
      expect((await loanRow(loan.id)).dueAt?.toISOString().slice(0, 10)).toBe(utcDay(5))
      expect(
        (await eventsOf(loan.id)).filter((event) => event.type === 'RECORD_AMENDED'),
      ).toHaveLength(0)
    })

    it('amend: некоректні дати й беззмістовна правка → 400, нічого не змінено', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })
      const before = await loanRow(loan.id)

      const future = await act(owner, loan.id, {
        action: 'amend_record',
        handedAt: utcDay(2),
      }).expect(400)

      expect(errorCode(future.body)).toBe(API_ERROR_CODES.LOAN_RECORD_DATE_INVALID)

      // Нова дата передачі пізніше за наявний строк.
      const late = await act(owner, loan.id, {
        action: 'amend_record',
        handedAt: utcDay(-1),
      }).expect(200)

      expect(loanResponseSchema.parse(late.body).loan.dueAt).toBe(utcDay(5))

      const beforeInvalid = await loanRow(loan.id)
      const earlyDue = await act(owner, loan.id, {
        action: 'amend_record',
        dueAt: utcDay(-5),
      }).expect(400)

      expect(errorCode(earlyDue.body)).toBe(API_ERROR_CODES.LOAN_RECORD_DATE_INVALID)
      expect(await loanRow(loan.id)).toEqual(beforeInvalid)

      const same = await act(owner, loan.id, { action: 'amend_record', dueAt: utcDay(5) }).expect(
        400,
      )

      expect(errorCode(same.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)

      for (const body of [
        { action: 'amend_record' },
        { action: 'amend_record', note: 'x', dueAt: utcDay(6) },
        { action: 'confirm_record', handedAt: utcDay(-1) },
        { action: 'withdraw_record', dueAt: utcDay(6) },
        { action: 'decline_record', note: 'ні' },
      ]) {
        const response = await act(owner, loan.id, body).expect(400)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }

      expect(before.status).toBe('PENDING_CONFIRMATION')
      expect(
        (await eventsOf(loan.id)).filter((event) => event.type === 'RECORD_AMENDED'),
      ).toHaveLength(1)
    })

    it('після підтвердження amend/withdraw/decline/confirm → 409 (Q12); дати не змінено', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(5) })

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      const before = await loanRow(loan.id)

      for (const [actor, body] of [
        [owner, { action: 'amend_record', handedAt: utcDay(-9) }],
        [owner, { action: 'amend_record', dueAt: utcDay(9) }],
        [owner, { action: 'withdraw_record' }],
        [borrower, { action: 'decline_record' }],
        [borrower, { action: 'confirm_record' }],
      ] as const) {
        const response = await act(actor, loan.id, body).expect(409)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
      }

      expect(await loanRow(loan.id)).toEqual(before)
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_CONFIRMED',
      ])
    })

    it('після відкликання/відмови amend і повторні дії → 409', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(owner, loan.id, { action: 'withdraw_record' }).expect(200)

      await act(owner, loan.id, { action: 'amend_record', dueAt: utcDay(3) }).expect(409)
      await act(borrower, loan.id, { action: 'confirm_record' }).expect(409)
      await act(borrower, loan.id, { action: 'decline_record' }).expect(409)
    })
  })

  describe('E6: права сторін', () => {
    it('стороння людина → 404; власник не підтверджує/не відхиляє; позичальник не відкликає/не виправляє', async () => {
      const { owner, borrower, shelf } = await pair()
      const outsider = await registerAccount(app, 'r10e-outsider')
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      for (const action of ['confirm_record', 'decline_record', 'withdraw_record']) {
        await act(outsider, loan.id, { action }).expect(404)
      }

      await request(http())
        .get(url(`/loans/${loan.id}`))
        .set('Cookie', outsider.cookie)
        .expect(404)

      for (const action of ['confirm_record', 'decline_record']) {
        const response = await act(owner, loan.id, { action }).expect(403)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.FORBIDDEN)
      }

      for (const body of [
        { action: 'withdraw_record' },
        { action: 'amend_record', dueAt: utcDay(3) },
      ]) {
        const response = await act(borrower, loan.id, body).expect(403)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.FORBIDDEN)
      }

      expect((await loanRow(loan.id)).status).toBe('PENDING_CONFIRMATION')
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')
    })

    it('невідомі дії й дії request-flow над записом → 409; record-дії над request-flow → 409', async () => {
      const { owner, borrower, shelf } = await pair()
      const recorded = await recordedLoan(app, owner, borrower, shelf.copyId)

      for (const [actor, action] of [
        [owner, 'approve'],
        [owner, 'reject'],
        [borrower, 'cancel'],
        [owner, 'cancel'],
        [borrower, 'hand_over'],
        [owner, 'return'],
        [owner, 'mark_lost'],
        [owner, 'recover'],
      ] as const) {
        const response = await act(actor, recorded.id, { action }).expect(409)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
      }

      // Після підтвердження request-flow дії теж не працюють.
      await act(borrower, recorded.id, { action: 'confirm_record' }).expect(200)

      for (const [actor, action] of [
        [owner, 'approve'],
        [owner, 'reject'],
        [borrower, 'cancel'],
        [borrower, 'hand_over'],
      ] as const) {
        await act(actor, recorded.id, { action }).expect(409)
      }

      // Дії запису над звичайною позикою.
      const shelf2 = await createShelfCopy(app, owner)
      const created = await requestLoan(app, borrower, shelf2.copyId).expect(201)
      const requestFlowId = loanResponseSchema.parse(created.body).loan.id

      for (const [actor, action] of [
        [borrower, 'confirm_record'],
        [borrower, 'decline_record'],
        [owner, 'withdraw_record'],
      ] as const) {
        const response = await act(actor, requestFlowId, { action }).expect(409)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
      }

      await act(owner, requestFlowId, { action: 'amend_record', dueAt: utcDay(3) }).expect(409)
      expect((await loanRow(requestFlowId)).status).toBe('REQUESTED')
    })

    it('синтетичний RECORDED_EXISTING зі status=REQUESTED/APPROVED і RECORDED_GUEST не стають легітимними', async () => {
      const { owner, borrower, shelf } = await pair()
      const other = await createShelfCopy(app, owner)
      const handedAt = new Date('2026-08-01T00:00:00Z')
      const data = {
        ownerId: owner.id,
        borrowerId: borrower.id,
        origin: 'RECORDED_EXISTING',
        handedAt,
      } as const

      // Повз API, напряму в БД: синтетичні рядки, яких стейт-машина не створює.
      const requested = await prisma.loan.create({
        data: { ...data, copyId: shelf.copyId, status: 'REQUESTED' },
      })
      const approved = await prisma.loan.create({
        data: { ...data, copyId: other.copyId, status: 'APPROVED' },
      })
      const guest = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerKind: 'GUEST',
          origin: 'RECORDED_GUEST',
          status: 'CANCELLED',
          handedAt,
        },
      })
      const ids = [requested.id, approved.id, guest.id]

      for (const id of ids) {
        for (const account of [owner, borrower]) {
          await request(http())
            .get(url(`/loans/${id}`))
            .set('Cookie', account.cookie)
            .expect(404)

          for (const action of ['approve', 'confirm_record', 'return']) {
            await act(account, id, { action }).expect(404)
          }
        }
      }

      const list = await request(http()).get(url('/loans')).set('Cookie', owner.cookie).expect(200)
      const listed = loanListResponseSchema.parse(list.body).loans.map((loan) => loan.id)

      for (const id of ids) expect(listed).not.toContain(id)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('E7: доступність до відповіді', () => {
    it('примірник RESERVED: не доступний у holders/бібліотеці, canRequest=false, нові запити 409, дату не видно', async () => {
      const { owner, borrower, shelf } = await pair()
      const viewer = await registerAccount(app, 'r10e-viewer')

      await befriend(app, owner, viewer)

      await recordedLoan(app, owner, borrower, shelf.copyId, { dueAt: utcDay(7) })

      const holders = await request(http())
        .get(url(`/works/${shelf.workId}/holders`))
        .set('Cookie', viewer.cookie)
        .expect(200)
      const copy = workHoldersResponseSchema.parse(holders.body).groups[0]?.owners[0]?.copies[0]

      expect(copy).toMatchObject({
        id: shelf.copyId,
        status: 'RESERVED',
        canRequest: false,
        expectedReturnAt: null,
      })

      const available = await request(http())
        .get(url(`/works/${shelf.workId}/holders?availability=AVAILABLE`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(workHoldersResponseSchema.parse(available.body).groups).toEqual([])

      const shelfView = await request(http())
        .get(url(`/users/${owner.id}/library`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(JSON.stringify(shelfView.body)).toContain('"canRequest":false')
      expect(JSON.stringify(shelfView.body)).not.toContain(utcDay(7))
      expect(JSON.stringify(shelfView.body)).not.toContain(borrower.id)

      const attempt = await requestLoan(app, viewer, shelf.copyId).expect(409)

      expect(errorCode(attempt.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)

      // Сторонній друг не бачить самого запису в `/loans`.
      const viewerLoans = await request(http())
        .get(url('/loans'))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect(loanListResponseSchema.parse(viewerLoans.body).loans).toEqual([])
    })

    it('власник у бібліотеці бачить запис як activeLoan; позичальник у чужій полиці — myActiveLoan', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      const own = await request(http())
        .get(url('/me/library'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const ownCopy = (
        own.body as {
          groups: { copies: { id: string; activeLoan: { id: string; status: string } | null }[] }[]
        }
      ).groups
        .flatMap((group) => group.copies)
        .find((candidate) => candidate.id === shelf.copyId)

      expect(ownCopy?.activeLoan).toMatchObject({ id: loan.id, status: 'PENDING_CONFIRMATION' })

      const theirs = await request(http())
        .get(url(`/users/${owner.id}/library`))
        .set('Cookie', borrower.cookie)
        .expect(200)

      expect(JSON.stringify(theirs.body)).toContain(loan.id)
    })

    it('видалення й архів примірника під записом → 409 (M5), Loan цілий', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      const archive = await request(http())
        .post(url(`/me/library/${shelf.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(409)

      expect(errorCode(archive.body)).toBe(API_ERROR_CODES.COPY_HAS_ACTIVE_LOAN)

      const removal = await request(http())
        .delete(url(`/me/library/${shelf.copyId}`))
        .set('Cookie', owner.cookie)
        .expect(409)

      expect([
        API_ERROR_CODES.COPY_HAS_ACTIVE_LOAN,
        API_ERROR_CODES.COPY_HAS_LOAN_HISTORY,
      ]).toContain(errorCode(removal.body))
      expect((await loanRow(loan.id)).status).toBe('PENDING_CONFIRMATION')
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('E8, C7–C9: конкуруючі REQUESTED', () => {
    async function withRivals() {
      const owner = await registerAccount(app, 'r10e-rival-owner')
      const borrower = await registerAccount(app, 'r10e-rival-borrower')
      const rivalOne = await registerAccount(app, 'r10e-rival-one')
      const rivalTwo = await registerAccount(app, 'r10e-rival-two')

      for (const other of [borrower, rivalOne, rivalTwo]) await befriend(app, owner, other)

      const shelf = await createShelfCopy(app, owner)
      const rivals = [] as { account: Account; id: string }[]

      for (const account of [rivalOne, rivalTwo]) {
        const created = await requestLoan(app, account, shelf.copyId).expect(201)

        rivals.push({ account, id: loanResponseSchema.parse(created.body).loan.id })
      }

      return { owner, borrower, shelf, rivals }
    }

    it('E8: створення запису не змінює REQUESTED і не шле LOAN_REJECTED', async () => {
      const { owner, borrower, shelf, rivals } = await withRivals()

      await recordedLoan(app, owner, borrower, shelf.copyId)

      for (const rival of rivals) {
        expect((await loanRow(rival.id)).status).toBe('REQUESTED')
        expect(await notificationsOf(rival.account.id, 'LOAN_REJECTED')).toHaveLength(0)
      }
    })

    it('C9: під PENDING approve чужого REQUESTED → 409, новий запит → LOAN_COPY_UNAVAILABLE, reject/cancel власного дозволені', async () => {
      const { owner, borrower, shelf, rivals } = await withRivals()
      const late = await registerAccount(app, 'r10e-rival-late')

      await befriend(app, owner, late)
      await recordedLoan(app, owner, borrower, shelf.copyId)

      const [first, second] = rivals

      if (first === undefined || second === undefined)
        throw new Error('Очікувалось двоє конкурентів')

      const approve = await act(owner, first.id, { action: 'approve' }).expect(409)

      expect([
        API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH,
        API_ERROR_CODES.LOAN_ALREADY_APPROVED,
      ]).toContain(errorCode(approve.body))
      expect((await loanRow(first.id)).status).toBe('REQUESTED')

      const fresh = await requestLoan(app, late, shelf.copyId).expect(409)

      expect(errorCode(fresh.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)

      await act(owner, first.id, { action: 'reject' }).expect(200)
      await act(second.account, second.id, { action: 'cancel' }).expect(200)
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')
    })

    it('C7: confirm_record атомарно відхиляє всіх справжніх конкурентів зі сповіщеннями', async () => {
      const { owner, borrower, shelf, rivals } = await withRivals()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

      // Синтетичний RECORDED_EXISTING зі REQUESTED не є конкурентом і не чіпається.
      const synthetic = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: borrower.id,
          origin: 'RECORDED_EXISTING',
          status: 'REQUESTED',
          handedAt: new Date('2026-08-01T00:00:00Z'),
        },
      })

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      for (const rival of rivals) {
        const row = await loanRow(rival.id)

        expect(row.status).toBe('REJECTED')
        expect(row.respondedAt).not.toBeNull()
        expect(await notificationsOf(rival.account.id, 'LOAN_REJECTED', rival.id)).toHaveLength(1)
      }

      expect((await loanRow(synthetic.id)).status).toBe('REQUESTED')
      expect(
        await prisma.loan.count({
          where: { copyId: shelf.copyId, status: 'REQUESTED', origin: 'REQUESTED' },
        }),
      ).toBe(0)
    })

    it.each(['decline_record', 'withdraw_record'] as const)(
      'C8: %s лишає чужі REQUESTED чинними, Copy AVAILABLE, і їх можна погодити',
      async (action) => {
        const { owner, borrower, shelf, rivals } = await withRivals()
        const loan = await recordedLoan(app, owner, borrower, shelf.copyId)

        await act(action === 'decline_record' ? borrower : owner, loan.id, { action }).expect(200)

        for (const rival of rivals) {
          expect((await loanRow(rival.id)).status).toBe('REQUESTED')
          expect(await notificationsOf(rival.account.id, 'LOAN_REJECTED')).toHaveLength(0)
        }

        expect((await copyRow(shelf.copyId)).status).toBe('AVAILABLE')

        const [first] = rivals

        await act(owner, first?.id ?? '', { action: 'approve' }).expect(200)
        expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')
      },
    )
  })

  // ---------------------------------------------------------------------------------------------
  describe('Підтверджена записана позика: return / mark_lost / recover', () => {
    async function confirmed(dueAt?: string) {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(
        app,
        owner,
        borrower,
        shelf.copyId,
        dueAt === undefined ? {} : { dueAt },
      )

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      return { owner, borrower, shelf, loan }
    }

    it('return: RETURNED, Copy AVAILABLE вдома, подія LOAN_RETURNED, минулі факти не переписано', async () => {
      const { owner, borrower, shelf, loan } = await confirmed()
      const response = await act(owner, loan.id, { action: 'return' }).expect(200)
      const returned = loanResponseSchema.parse(response.body).loan

      expect(returned.status).toBe('RETURNED')
      expect(returned.handedAt).toBe(loan.handedAt)
      expect(returned.requestedAt).toBeNull()

      const copy = await copyRow(shelf.copyId)

      expect(copy.status).toBe('AVAILABLE')
      expect(copy.currentHolderId).toBe(owner.id)
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_CONFIRMED',
        'LOAN_RETURNED',
      ])
      expect(await notificationsOf(borrower.id, 'LOAN_RETURNED', loan.id)).toHaveLength(1)
      // Записана позика не потрапляє в кроки core loop.
      expect(
        await prisma.productEvent.count({
          where: { subjectUserId: { in: [owner.id, borrower.id] }, type: 'LOAN_RETURNED' },
        }),
      ).toBe(0)
    })

    it('mark_lost → recover: LOST лишається LOST, Copy знову AVAILABLE', async () => {
      const { owner, shelf, loan } = await confirmed()

      await act(owner, loan.id, { action: 'mark_lost' }).expect(200)

      expect((await copyRow(shelf.copyId)).status).toBe('UNAVAILABLE')

      const response = await act(owner, loan.id, {
        action: 'recover',
        effectiveAt: utcDay(-1),
      }).expect(200)
      const recovered = loanResponseSchema.parse(response.body).loan

      expect(recovered.status).toBe('LOST')
      expect(recovered.recovery?.effectiveAt).toBe(`${utcDay(-1)}T00:00:00.000Z`)
      expect((await copyRow(shelf.copyId)).status).toBe('AVAILABLE')
      expect((await eventsOf(loan.id)).map((event) => event.type)).toEqual([
        'RECORD_PROPOSED',
        'RECORD_CONFIRMED',
        'LOAN_LOST',
        'RECOVERED',
      ])

      const again = await act(owner, loan.id, { action: 'recover' }).expect(409)

      expect(errorCode(again.body)).toBe(API_ERROR_CODES.LOAN_ALREADY_RECOVERED)
    })

    it('після return примірник знову можна записати', async () => {
      const { owner, borrower, shelf, loan } = await confirmed()

      await act(owner, loan.id, { action: 'return' }).expect(200)
      await recordedLoan(app, owner, borrower, shelf.copyId)
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('Історія й приватність претензій (T5)', () => {
    it('друг не бачить PENDING/DECLINED/відкликаний запис; після підтвердження бачить факт із origin', async () => {
      const { owner, borrower, shelf } = await pair()
      const friend = await registerAccount(app, 'r10e-hist-friend')

      await befriend(app, owner, friend)

      const historyFor = async (account: Account) => {
        const response = await request(http())
          .get(url(`/copies/${shelf.copyId}/history`))
          .set('Cookie', account.cookie)
          .expect(200)

        return copyHistoryResponseSchema.parse(response.body).entries
      }
      const workFor = async (account: Account) => {
        const response = await request(http())
          .get(url(`/works/${shelf.workId}/history`))
          .set('Cookie', account.cookie)
          .expect(200)

        return workHistoryResponseSchema.parse(response.body).entries
      }

      const first = await recordedLoan(app, owner, borrower, shelf.copyId)

      expect(await historyFor(friend)).toEqual([])
      expect(await workFor(friend)).toEqual([])
      expect((await historyFor(owner)).map((entry) => entry.status)).toEqual([
        'PENDING_CONFIRMATION',
      ])
      expect((await historyFor(borrower)).map((entry) => entry.status)).toEqual([
        'PENDING_CONFIRMATION',
      ])

      await act(owner, first.id, { action: 'withdraw_record' }).expect(200)

      expect(await historyFor(friend)).toEqual([])
      expect((await historyFor(owner)).map((entry) => entry.status)).toEqual(['CANCELLED'])

      const second = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(borrower, second.id, { action: 'decline_record' }).expect(200)

      expect(await historyFor(friend)).toEqual([])
      expect(await workFor(friend)).toEqual([])

      const third = await recordedLoan(app, owner, borrower, shelf.copyId)

      await act(borrower, third.id, { action: 'confirm_record' }).expect(200)

      const visible = await historyFor(friend)

      expect(visible).toHaveLength(1)
      expect(visible[0]).toMatchObject({
        status: 'HANDED_OVER',
        origin: 'RECORDED_EXISTING',
        requestedAt: null,
      })
      expect(await workFor(friend)).toHaveLength(1)
      // Претензії лишаються сторонам у «Моїй історії».
      const mine = await request(http())
        .get(url('/me/history'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(JSON.stringify(mine.body)).toContain('DECLINED')
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe('C6 і Q6: дайджест та відсутність auto-expiry', () => {
    it('pending із простроченим dueAt не прострочений; після підтвердження — одне LOAN_OVERDUE без дублів', async () => {
      const { owner, borrower, shelf } = await pair()
      const loan = await recordedLoan(app, owner, borrower, shelf.copyId, {
        handedAt: utcDay(-40),
        dueAt: utcDay(-20),
      })
      const now = new Date()

      // Q6: прохід дайджесту нічого не скасовує й не змінює.
      await digest.run(now)

      expect(await notificationsOf(borrower.id, 'LOAN_OVERDUE', loan.id)).toHaveLength(0)
      expect((await loanRow(loan.id)).status).toBe('PENDING_CONFIRMATION')
      expect((await copyRow(shelf.copyId)).status).toBe('RESERVED')

      const pending = await request(http())
        .get(url(`/loans/${loan.id}`))
        .set('Cookie', borrower.cookie)
        .expect(200)

      expect(loanResponseSchema.parse(pending.body).loan.isOverdue).toBe(false)

      await act(borrower, loan.id, { action: 'confirm_record' }).expect(200)

      const confirmedResponse = await request(http())
        .get(url(`/loans/${loan.id}`))
        .set('Cookie', borrower.cookie)
        .expect(200)

      expect(loanResponseSchema.parse(confirmedResponse.body).loan.isOverdue).toBe(true)

      await digest.run(now)
      await digest.run(now)

      const overdue = await prisma.notification.findMany({
        where: { userId: borrower.id, type: 'LOAN_OVERDUE' },
      })

      expect(overdue).toHaveLength(1)
      expect(overdue[0]?.payload).toMatchObject({ loanId: loan.id })
    })
  })
})
