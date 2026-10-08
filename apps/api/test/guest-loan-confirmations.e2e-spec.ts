import './helpers/guest-loans-on'
import 'reflect-metadata'
import { Client } from 'pg'
import request from 'supertest'
import {
  apiErrorSchema,
  copyHistoryResponseSchema,
  externalBorrowerListResponseSchema,
  guestLoanConfirmationListResponseSchema,
  guestLoanConfirmationResponseSchema,
  guestLoanListResponseSchema,
  guestLoanResponseSchema,
  externalBorrowerResponseSchema,
  myHistoryResponseSchema,
  workHistoryResponseSchema,
  type ApiErrorCode,
  type GuestLoanConfirmation,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { beginRequest, waitForBlockedBackend } from './concurrency.helpers'
import { testDatabaseUrl } from './db/test-database'
import {
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { GuestContactRetentionCleanupService } from '../src/external-borrowers/guest-contact-retention-cleanup.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10i.1 (docs/plan/stage-10-real-world-history.md, §0.13, §6.12): owner-only ресурс
 * `/api/v1/guest-loan-confirmations`. Лише синтетичні дані (D2 відкритий release blocker).
 * Публічних маршрутів гостя (10i.2) тут немає: стан `DENIED` виставляється прямим записом у БД —
 * саме так тест відтворює майбутню відповідь гостя, не будуючи її.
 */
describe('Stage 10 (10i.1): запит гостьового підтвердження, owner-only (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cleanup: GuestContactRetentionCleanupService
  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): ApiErrorCode => apiErrorSchema.parse(body).code
  const DAY_MS = 24 * 60 * 60 * 1000

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    cleanup = new GuestContactRetentionCleanupService(prisma)
  })

  afterAll(async () => {
    await app.close()
  })

  async function createContact(account: Account, alias: string): Promise<string> {
    const response = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', account.cookie)
      .send({ alias, ownerInformed: true })
      .expect(201)

    return externalBorrowerResponseSchema.parse(response.body).contact.id
  }

  const createConfirmation = (account: Account, body: Record<string, unknown>): request.Test =>
    request(http()).post(url('/guest-loan-confirmations')).set('Cookie', account.cookie).send(body)

  const actOnConfirmation = (
    account: Account,
    id: string,
    body: Record<string, unknown>,
  ): request.Test =>
    request(http())
      .patch(url(`/guest-loan-confirmations/${id}`))
      .set('Cookie', account.cookie)
      .send(body)

  const cancelHandover = (account: Account, id: string): request.Test =>
    actOnConfirmation(account, id, { action: 'cancel_handover', bookIsWithOwner: true })

  const recordStatement = (account: Account, id: string): request.Test =>
    actOnConfirmation(account, id, { action: 'record_owner_statement' })

  const getConfirmation = (account: Account, id: string): request.Test =>
    request(http())
      .get(url(`/guest-loan-confirmations/${id}`))
      .set('Cookie', account.cookie)

  const deleteContact = (account: Account, id: string): request.Test =>
    request(http())
      .delete(url(`/me/external-borrowers/${id}`))
      .set('Cookie', account.cookie)

  async function pending(
    owner: Account,
    shelf: Shelf,
    contactId: string,
    extra: Record<string, unknown> = {},
  ): Promise<GuestLoanConfirmation> {
    const response = await createConfirmation(owner, {
      copyId: shelf.copyId,
      externalBorrowerId: contactId,
      handedAt: '2026-01-01',
      ...extra,
    }).expect(201)

    return guestLoanConfirmationResponseSchema.parse(response.body).confirmation
  }

  /** Знімок стану, який жоден відмовлений/недозволений виклик не має змінити. */
  async function stateOf(
    copyId: string,
  ): Promise<{ copy: unknown; loans: unknown[]; events: number; confirmations: unknown[] }> {
    const copy = await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })
    const loans = await prisma.loan.findMany({ where: { copyId }, orderBy: { id: 'asc' } })
    const events = await prisma.loanEvent.count({ where: { loan: { copyId } } })
    const confirmations = await prisma.guestLoanConfirmation.findMany({
      where: { loan: { copyId } },
      orderBy: { id: 'asc' },
    })

    return { copy, loans, events, confirmations }
  }

  describe('створення: PENDING_CONFIRMATION / RESERVED, без фіктивного User', () => {
    it('Loan=PENDING_CONFIRMATION, Copy=RESERVED (тримач — контакт), retainUntil=NULL, подія запиту, User не створюється', async () => {
      const owner = await registerAccount(app, 'gc-create-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC1')
      const usersBefore = await prisma.user.count()

      const confirmation = await pending(owner, shelf, contactId, { dueAt: '2026-02-01' })

      expect(confirmation.status).toBe('OPEN')
      expect(confirmation.evidence).toBe('AWAITING_GUEST')
      expect(confirmation.resolvedAt).toBeNull()
      expect(confirmation.loan.status).toBe('PENDING_CONFIRMATION')
      expect(confirmation.loan.dueAt).toBe('2026-02-01')
      expect(confirmation.copy.status).toBe('RESERVED')
      expect(confirmation.contact).toEqual({
        id: contactId,
        alias: 'Гість GC1',
        guestNickname: null,
        guestEmail: null,
        guestEmailVerifiedAt: null,
      })

      expect(await prisma.user.count()).toBe(usersBefore)

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('RESERVED')
      expect(copy.currentHolderId).toBeNull()
      expect(copy.heldByContactId).toBe(contactId)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: confirmation.loan.id } })

      expect(loan).toMatchObject({
        status: 'PENDING_CONFIRMATION',
        borrowerId: null,
        borrowerKind: 'GUEST',
        origin: 'RECORDED_GUEST',
        borrowerContactId: contactId,
        requestedAt: null,
      })

      const contact = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

      expect(contact.retainUntil).toBeNull()

      const events = await prisma.loanEvent.findMany({ where: { loanId: loan.id } })

      expect(events.map((event) => event.type)).toEqual(['GUEST_CONFIRMATION_REQUESTED'])
      expect(events[0]?.payload).toEqual({})
      expect(events[0]?.actorId).toBe(owner.id)
    })

    it('чужі REQUESTED при створенні НЕ відхиляються і не отримують сповіщень (§0.13 п. 3)', async () => {
      const owner = await registerAccount(app, 'gc-rival-owner')
      const rival = await registerAccount(app, 'gc-rival')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const requested = await requestLoan(app, rival, shelf.copyId).expect(201)
      const rivalLoanId = (requested.body as { loan: { id: string } }).loan.id
      const contactId = await createContact(owner, 'Гість GC-rival')
      const rivalBefore = await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })

      await pending(owner, shelf, contactId)

      const rivalAfter = await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })

      expect(rivalAfter).toEqual(rivalBefore)
      expect(rivalAfter.status).toBe('REQUESTED')
      expect(
        await prisma.notification.count({ where: { userId: rival.id, type: 'LOAN_REJECTED' } }),
      ).toBe(0)
    })

    it('валідація: strict-тіло (email/зайві поля), відсутні поля, дати — 400 без жодної мутації', async () => {
      const owner = await registerAccount(app, 'gc-validate')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-validate')
      const before = await stateOf(shelf.copyId)
      const valid = { copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' }

      for (const body of [
        { ...valid, email: 'guest@guest.invalid' },
        { ...valid, guestNickname: 'Хтось' },
        { ...valid, ownerId: owner.id },
        { ...valid, dueAt: null },
        { ...valid, dueAt: '2025-12-31' },
        { ...valid, handedAt: '2999-01-01' },
        { ...valid, handedAt: 'вчора' },
        { externalBorrowerId: contactId, handedAt: '2026-01-01' },
        { copyId: shelf.copyId, handedAt: '2026-01-01' },
        { copyId: shelf.copyId, externalBorrowerId: contactId },
      ]) {
        const response = await createConfirmation(owner, body)

        expect([400]).toContain(response.status)
      }

      expect(await stateOf(shelf.copyId)).toEqual(before)
    })

    it('чужий контакт, чужий примірник, вигаданий id — 404 без мутації; без сесії — 401', async () => {
      const owner = await registerAccount(app, 'gc-authz-owner')
      const stranger = await registerAccount(app, 'gc-authz-stranger')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-authz')
      const strangerContactId = await createContact(stranger, 'Чужий контакт')
      const before = await stateOf(shelf.copyId)
      const base = { handedAt: '2026-01-01' }

      for (const body of [
        { ...base, copyId: shelf.copyId, externalBorrowerId: strangerContactId },
        { ...base, copyId: 'no-such-copy', externalBorrowerId: contactId },
      ]) {
        const response = await createConfirmation(owner, body)

        expect(response.status).toBe(404)
        expect(errorCode(response.body)).toBe('NOT_FOUND')
      }

      const foreignShelf = await createShelfCopy(app, stranger)
      const foreignCopy = await createConfirmation(owner, {
        ...base,
        copyId: foreignShelf.copyId,
        externalBorrowerId: contactId,
      })

      expect(foreignCopy.status).toBe(404)
      expect(await stateOf(shelf.copyId)).toEqual(before)

      await request(http())
        .post(url('/guest-loan-confirmations'))
        .send({ ...base, copyId: shelf.copyId, externalBorrowerId: contactId })
        .expect(401)
    })

    it('зайнятий (не AVAILABLE) і заархівований примірник — 409; новий запит на той самий примірник — 409', async () => {
      const owner = await registerAccount(app, 'gc-busy')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-busy')

      await pending(owner, shelf, contactId)

      const second = await createConfirmation(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-02',
      })

      expect(second.status).toBe(409)
      expect(errorCode(second.body)).toBe('LOAN_COPY_UNAVAILABLE')

      // Ручний шлях 10f.3 теж не може взяти RESERVED-примірник.
      const manual = await request(http())
        .post(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-02' })

      expect(manual.status).toBe(409)
      expect(errorCode(manual.body)).toBe('LOAN_COPY_UNAVAILABLE')

      const archivedShelf = await createShelfCopy(app, owner)

      await request(http())
        .post(url(`/me/library/${archivedShelf.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const archived = await createConfirmation(owner, {
        copyId: archivedShelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-02',
      })

      expect(archived.status).toBe(409)
      expect(errorCode(archived.body)).toBe('COPY_ARCHIVED')
    })
  })

  describe('читання: окремий owner-only ресурс, не старий контракт 10f.3', () => {
    it('GET /:id і список віддають запит лише власнику; чужий — 404 і порожній список', async () => {
      const owner = await registerAccount(app, 'gc-read-owner')
      const stranger = await registerAccount(app, 'gc-read-stranger')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-read')
      const confirmation = await pending(owner, shelf, contactId)

      const own = await getConfirmation(owner, confirmation.id).expect(200)

      expect(guestLoanConfirmationResponseSchema.parse(own.body).confirmation.id).toBe(
        confirmation.id,
      )

      const foreign = await getConfirmation(stranger, confirmation.id)

      expect(foreign.status).toBe(404)
      expect(errorCode(foreign.body)).toBe('NOT_FOUND')
      expect((await getConfirmation(owner, 'no-such-id')).status).toBe(404)

      const ownList = await request(http())
        .get(url('/guest-loan-confirmations'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const strangerList = await request(http())
        .get(url('/guest-loan-confirmations'))
        .set('Cookie', stranger.cookie)
        .expect(200)

      expect(
        guestLoanConfirmationListResponseSchema
          .parse(ownList.body)
          .confirmations.map((item) => item.id),
      ).toEqual([confirmation.id])
      expect(
        guestLoanConfirmationListResponseSchema.parse(strangerList.body).confirmations,
      ).toEqual([])
      await request(http()).get(url('/guest-loan-confirmations')).expect(401)
    })

    it('очікуваний запит НЕ видно через старий /loans/guest: не у списку, GET/PATCH — 404, /loans — без гостьових', async () => {
      const owner = await registerAccount(app, 'gc-isolation')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-isolation')
      const confirmation = await pending(owner, shelf, contactId)
      const before = await stateOf(shelf.copyId)

      const list = await request(http())
        .get(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(
        guestLoanListResponseSchema.parse(list.body).loans.map((loan) => loan.id),
      ).not.toContain(confirmation.loan.id)

      await request(http())
        .get(url(`/loans/guest/${confirmation.loan.id}`))
        .set('Cookie', owner.cookie)
        .expect(404)

      for (const action of ['return', 'mark_lost', 'recover', 'close_loss']) {
        await request(http())
          .patch(url(`/loans/guest/${confirmation.loan.id}`))
          .set('Cookie', owner.cookie)
          .send({ action })
          .expect(404)
      }

      const registered = await request(http())
        .get(url('/loans?role=owner'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(JSON.stringify(registered.body)).not.toContain(confirmation.loan.id)
      expect(await stateOf(shelf.copyId)).toEqual(before)
    })

    it('старі ручні позики 10f.3 не мають рядка підтвердження, лишаються «зі слів власника» і не потрапляють у новий ресурс', async () => {
      const owner = await registerAccount(app, 'gc-legacy')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-legacy')

      const created = await request(http())
        .post(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
        .expect(201)
      const loan = guestLoanResponseSchema.parse(created.body).loan

      expect(loan.status).toBe('HANDED_OVER')
      expect(loan.evidence).toBe('OWNER_STATEMENT')
      expect(await prisma.guestLoanConfirmation.count({ where: { loanId: loan.id } })).toBe(0)

      const list = await request(http())
        .get(url('/guest-loan-confirmations'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(guestLoanConfirmationListResponseSchema.parse(list.body).confirmations).toEqual([])

      // Старий GET/PATCH працюють як раніше.
      const got = await request(http())
        .get(url(`/loans/guest/${loan.id}`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(guestLoanResponseSchema.parse(got.body).loan.evidence).toBe('OWNER_STATEMENT')

      const returned = await request(http())
        .patch(url(`/loans/guest/${loan.id}`))
        .set('Cookie', owner.cookie)
        .send({ action: 'return' })
        .expect(200)

      expect(guestLoanResponseSchema.parse(returned.body).loan.status).toBe('RETURNED')

      // Новий ресурс не відкриває стару позику навіть за прямим id.
      await getConfirmation(owner, loan.id).expect(404)
    })
  })

  describe('скасування помилкової передачі', () => {
    it('cancel_handover: Loan=CANCELLED, Copy=AVAILABLE вдома, подія, retainUntil = occurredAt + 90д, REQUESTED не змінюються', async () => {
      const owner = await registerAccount(app, 'gc-cancel-owner')
      const rival = await registerAccount(app, 'gc-cancel-rival')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const requested = await requestLoan(app, rival, shelf.copyId).expect(201)
      const rivalLoanId = (requested.body as { loan: { id: string } }).loan.id
      const contactId = await createContact(owner, 'Гість GC-cancel')
      const confirmation = await pending(owner, shelf, contactId)

      const response = await cancelHandover(owner, confirmation.id).expect(200)
      const cancelled = guestLoanConfirmationResponseSchema.parse(response.body).confirmation

      expect(cancelled.status).toBe('CANCELLED')
      expect(cancelled.evidence).toBeNull()
      expect(cancelled.resolvedAt).not.toBeNull()
      expect(cancelled.loan.status).toBe('CANCELLED')
      expect(cancelled.copy.status).toBe('AVAILABLE')

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy).toMatchObject({
        status: 'AVAILABLE',
        currentHolderId: owner.id,
        heldByContactId: null,
      })

      // `Loan.borrowerContactId` лишається (потрібен для D3-доданка й аудиту).
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: cancelled.loan.id } })

      expect(loan.status).toBe('CANCELLED')
      expect(loan.borrowerContactId).toBe(contactId)

      const event = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId: loan.id, type: 'GUEST_HANDOVER_CANCELLED' },
      })

      expect(event.payload).toEqual({})
      expect(event.actorId).toBe(owner.id)

      const contact = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

      expect(contact.retainUntil?.getTime()).toBe(event.occurredAt.getTime() + 90 * DAY_MS)

      expect((await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })).status).toBe(
        'REQUESTED',
      )
      expect(
        await prisma.notification.count({ where: { userId: rival.id, type: 'LOAN_REJECTED' } }),
      ).toBe(0)
    })

    it('потрібна явна заява власника: без bookIsWithOwner/false/зайві поля — 400 без мутації', async () => {
      const owner = await registerAccount(app, 'gc-cancel-claim')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-claim')
      const confirmation = await pending(owner, shelf, contactId)
      const before = await stateOf(shelf.copyId)

      for (const body of [
        { action: 'cancel_handover' },
        { action: 'cancel_handover', bookIsWithOwner: false },
        { action: 'cancel_handover', bookIsWithOwner: null },
        { action: 'cancel_handover', bookIsWithOwner: 'true' },
        { action: 'record_owner_statement', bookIsWithOwner: true },
        { action: 'reject' },
        { action: 'return' },
        {},
        { action: 'cancel_handover', bookIsWithOwner: true, note: 'x' },
      ]) {
        const response = await actOnConfirmation(owner, confirmation.id, body)

        expect(response.status).toBe(400)
      }

      expect(await stateOf(shelf.copyId)).toEqual(before)
    })

    it('після скасування: повторна дія — 409 LOAN_INVALID_TRANSITION без другої події; примірник можна віддати знову', async () => {
      const owner = await registerAccount(app, 'gc-cancel-twice')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-twice')
      const confirmation = await pending(owner, shelf, contactId)

      await cancelHandover(owner, confirmation.id).expect(200)

      const before = await stateOf(shelf.copyId)

      for (const send of [cancelHandover, recordStatement]) {
        const response = await send(owner, confirmation.id)

        expect(response.status).toBe(409)
        expect(errorCode(response.body)).toBe('LOAN_INVALID_TRANSITION')
      }

      expect(await stateOf(shelf.copyId)).toEqual(before)

      // Скасований запит не видно старим контрактом, а книжку можна віддати заново.
      await request(http())
        .get(url(`/loans/guest/${confirmation.loan.id}`))
        .set('Cookie', owner.cookie)
        .expect(404)

      const again = await pending(owner, shelf, contactId)

      expect(again.id).not.toBe(confirmation.id)
      expect(again.copy.status).toBe('RESERVED')
    })

    it('чужий власник не може ні скасувати, ні записати — 404 без мутації', async () => {
      const owner = await registerAccount(app, 'gc-cancel-authz')
      const stranger = await registerAccount(app, 'gc-cancel-stranger')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-cancel-authz')
      const confirmation = await pending(owner, shelf, contactId)
      const before = await stateOf(shelf.copyId)

      for (const send of [cancelHandover, recordStatement]) {
        const response = await send(stranger, confirmation.id)

        expect(response.status).toBe(404)
      }

      expect((await cancelHandover(owner, 'no-such-id')).status).toBe(404)
      await request(http())
        .patch(url(`/guest-loan-confirmations/${confirmation.id}`))
        .send({ action: 'record_owner_statement' })
        .expect(401)
      expect(await stateOf(shelf.copyId)).toEqual(before)
    })
  })

  describe('запис лише зі слів власника', () => {
    it('record_owner_statement: HANDED_OVER/LENT_OUT, OWNER_RECORDED, подія, retainUntil=NULL; REQUESTED відхиляються атомарно зі сповіщенням', async () => {
      const owner = await registerAccount(app, 'gc-record-owner')
      const rivalOne = await registerAccount(app, 'gc-record-rival1')
      const rivalTwo = await registerAccount(app, 'gc-record-rival2')

      await befriend(app, owner, rivalOne)
      await befriend(app, owner, rivalTwo)

      const shelf = await createShelfCopy(app, owner)
      const requestOne = await requestLoan(app, rivalOne, shelf.copyId).expect(201)
      const requestTwo = await requestLoan(app, rivalTwo, shelf.copyId).expect(201)
      const contactId = await createContact(owner, 'Гість GC-record')
      const confirmation = await pending(owner, shelf, contactId)

      // До запису чужі REQUESTED цілі.
      expect(
        (
          await prisma.loan.findUniqueOrThrow({
            where: { id: (requestOne.body as { loan: { id: string } }).loan.id },
          })
        ).status,
      ).toBe('REQUESTED')

      const response = await recordStatement(owner, confirmation.id).expect(200)
      const recorded = guestLoanConfirmationResponseSchema.parse(response.body).confirmation

      expect(recorded.status).toBe('OWNER_RECORDED')
      expect(recorded.evidence).toBe('OWNER_STATEMENT')
      expect(recorded.loan.status).toBe('HANDED_OVER')
      expect(recorded.loan.handedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(recorded.copy.status).toBe('LENT_OUT')

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy).toMatchObject({
        status: 'LENT_OUT',
        currentHolderId: null,
        heldByContactId: contactId,
      })
      expect(
        (await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })).retainUntil,
      ).toBeNull()

      const events = await prisma.loanEvent.findMany({
        where: { loanId: recorded.loan.id },
        orderBy: { occurredAt: 'asc' },
      })

      expect(events.map((event) => event.type)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_OWNER_RECORDED',
      ])

      for (const [rival, sent] of [
        [rivalOne, requestOne],
        [rivalTwo, requestTwo],
      ] as const) {
        const rivalLoan = await prisma.loan.findUniqueOrThrow({
          where: { id: (sent.body as { loan: { id: string } }).loan.id },
        })

        expect(rivalLoan.status).toBe('REJECTED')
        expect(rivalLoan.respondedAt).not.toBeNull()
        expect(
          await prisma.notification.count({ where: { userId: rival.id, type: 'LOAN_REJECTED' } }),
        ).toBe(1)
      }
    })

    it('після запису позика керується старим /loans/guest (evidence OWNER_STATEMENT, return → RETURNED), а retainUntil = returnedAt + 90д', async () => {
      const owner = await registerAccount(app, 'gc-record-return')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-record-return')
      const confirmation = await pending(owner, shelf, contactId)

      await recordStatement(owner, confirmation.id).expect(200)

      const got = await request(http())
        .get(url(`/loans/guest/${confirmation.loan.id}`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(guestLoanResponseSchema.parse(got.body).loan.evidence).toBe('OWNER_STATEMENT')

      const returned = await request(http())
        .patch(url(`/loans/guest/${confirmation.loan.id}`))
        .set('Cookie', owner.cookie)
        .send({ action: 'return' })
        .expect(200)

      expect(guestLoanResponseSchema.parse(returned.body).loan.status).toBe('RETURNED')

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: confirmation.loan.id } })
      const contact = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

      expect(contact.retainUntil?.getTime()).toBe(loan.returnedAt!.getTime() + 90 * DAY_MS)

      // Підтвердження вже не «відкрите»: жодна дія власника над ним неможлива.
      const late = await cancelHandover(owner, confirmation.id)

      expect(late.status).toBe(409)
      expect(errorCode(late.body)).toBe('LOAN_INVALID_TRANSITION')

      const stillReadable = await getConfirmation(owner, confirmation.id).expect(200)

      expect(
        guestLoanConfirmationResponseSchema.parse(stillReadable.body).confirmation,
      ).toMatchObject({
        status: 'OWNER_RECORDED',
        loan: { status: 'RETURNED' },
      })
    })
  })

  describe('«Не отримував» (DENIED виставлено напряму — публічного шляху ще немає)', () => {
    async function deniedConfirmation(
      owner: Account,
      label: string,
    ): Promise<{ confirmation: GuestLoanConfirmation; shelf: Shelf; contactId: string }> {
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, `Гість ${label}`)
      const confirmation = await pending(owner, shelf, contactId)

      await prisma.guestLoanConfirmation.update({
        where: { id: confirmation.id },
        data: { status: 'DENIED' },
      })

      return { confirmation, shelf, contactId }
    }

    it('DENIED сам по собі Copy не звільняє: RESERVED лишається, evidence = GUEST_DENIED, DELETE контакту заблоковано', async () => {
      const owner = await registerAccount(app, 'gc-denied-state')
      const { confirmation, shelf, contactId } = await deniedConfirmation(owner, 'GC-denied')

      const got = await getConfirmation(owner, confirmation.id).expect(200)
      const parsed = guestLoanConfirmationResponseSchema.parse(got.body).confirmation

      expect(parsed.status).toBe('DENIED')
      expect(parsed.evidence).toBe('GUEST_DENIED')
      expect(parsed.loan.status).toBe('PENDING_CONFIRMATION')
      expect(parsed.copy.status).toBe('RESERVED')

      const blocked = await deleteContact(owner, contactId)

      expect(blocked.status).toBe(409)
      expect(errorCode(blocked.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('RESERVED')
    })

    it('з DENIED власник скасовує (книжка в нього): CANCELLED/AVAILABLE, після чого DELETE контакту дозволено', async () => {
      const owner = await registerAccount(app, 'gc-denied-cancel')
      const { confirmation, shelf, contactId } = await deniedConfirmation(owner, 'GC-denied-c')

      const response = await cancelHandover(owner, confirmation.id).expect(200)
      const parsed = guestLoanConfirmationResponseSchema.parse(response.body).confirmation

      expect(parsed.status).toBe('CANCELLED')
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'AVAILABLE',
      )

      await deleteContact(owner, contactId).expect(204)
    })

    it('з DENIED власник залишає позику активною зі своїх слів (книжки в нього немає): передачу не скасовано, Copy=LENT_OUT', async () => {
      const owner = await registerAccount(app, 'gc-denied-record')
      const { confirmation, shelf } = await deniedConfirmation(owner, 'GC-denied-r')

      const response = await recordStatement(owner, confirmation.id).expect(200)
      const parsed = guestLoanConfirmationResponseSchema.parse(response.body).confirmation

      expect(parsed.status).toBe('OWNER_RECORDED')
      expect(parsed.evidence).toBe('OWNER_STATEMENT')
      expect(parsed.loan.status).toBe('HANDED_OVER')
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'LENT_OUT',
      )
    })

    it('термінальний RECEIVED (майбутня відповідь гостя) не розв’язується власником: 409', async () => {
      const owner = await registerAccount(app, 'gc-received')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-received')
      const confirmation = await pending(owner, shelf, contactId)

      // Синтетичний стан «гість підтвердив»: рядок RECEIVED + позика/примірник у HANDED_OVER/LENT_OUT.
      await prisma.$transaction([
        prisma.loan.update({
          where: { id: confirmation.loan.id },
          data: { status: 'HANDED_OVER' },
        }),
        prisma.copy.update({ where: { id: shelf.copyId }, data: { status: 'LENT_OUT' } }),
        prisma.guestLoanConfirmation.update({
          where: { id: confirmation.id },
          data: { status: 'RECEIVED', resolvedAt: new Date() },
        }),
      ])

      const response = await cancelHandover(owner, confirmation.id)

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_INVALID_TRANSITION')

      // Старий контракт показує джерело як «підтверджено гостем», а не «зі слів власника».
      const got = await request(http())
        .get(url(`/loans/guest/${confirmation.loan.id}`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(guestLoanResponseSchema.parse(got.body).loan.evidence).toBe('GUEST_CONFIRMED')
    })

    it('розбіжність станів (Copy змінено в обхід сервісу) — 409 LOAN_COPY_STATE_MISMATCH без мутації', async () => {
      const owner = await registerAccount(app, 'gc-mismatch')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-mismatch')
      const confirmation = await pending(owner, shelf, contactId)

      await prisma.copy.update({ where: { id: shelf.copyId }, data: { status: 'UNAVAILABLE' } })

      const before = await stateOf(shelf.copyId)
      const response = await cancelHandover(owner, confirmation.id)

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_COPY_STATE_MISMATCH')
      expect(await stateOf(shelf.copyId)).toEqual(before)
    })
  })

  describe('ручний DELETE контакту і CLI-чистка після скасування (Q26)', () => {
    it('відкритий запит блокує DELETE (409); після скасування — 204, Loan/LoanEvent/рядок підтвердження лишаються, Copy AVAILABLE', async () => {
      const owner = await registerAccount(app, 'gc-delete')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-delete')
      const confirmation = await pending(owner, shelf, contactId)

      const blocked = await deleteContact(owner, contactId)

      expect(blocked.status).toBe(409)
      expect(errorCode(blocked.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')
      expect((await prisma.externalBorrower.findUnique({ where: { id: contactId } }))?.id).toBe(
        contactId,
      )

      await cancelHandover(owner, confirmation.id).expect(200)
      await deleteContact(owner, contactId).expect(204)

      expect(await prisma.externalBorrower.findUnique({ where: { id: contactId } })).toBeNull()

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: confirmation.loan.id } })

      expect(loan.status).toBe('CANCELLED')
      expect(loan.borrowerContactId).toBeNull()
      expect(loan.borrowerKind).toBe('GUEST')
      expect(await prisma.loanEvent.count({ where: { loanId: loan.id } })).toBe(2)

      const row = await prisma.guestLoanConfirmation.findUniqueOrThrow({
        where: { id: confirmation.id },
      })

      expect(row.externalBorrowerId).toBeNull()
      expect(row.status).toBe('CANCELLED')
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'AVAILABLE',
      )

      // Власник і далі читає запит (contact = null), а Copy — доступний для нової позики.
      const got = await getConfirmation(owner, confirmation.id).expect(200)

      expect(guestLoanConfirmationResponseSchema.parse(got.body).confirmation.contact).toBeNull()
    })

    it('після скасування DELETE не залежить від 90-денного строку, але інша активна позика того ж контакту його блокує', async () => {
      const owner = await registerAccount(app, 'gc-delete-other')
      const cancelledShelf = await createShelfCopy(app, owner)
      const otherShelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-delete-other')
      const cancelled = await pending(owner, cancelledShelf, contactId)

      await cancelHandover(owner, cancelled.id).expect(200)

      const other = await pending(owner, otherShelf, contactId)

      expect(
        (await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })).retainUntil,
      ).toBeNull()

      const blocked = await deleteContact(owner, contactId)

      expect(blocked.status).toBe(409)
      expect(errorCode(blocked.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')

      await cancelHandover(owner, other.id).expect(200)
      await deleteContact(owner, contactId).expect(204)
    })

    it('CLI-чистка: контакт зі скасованою передачею видаляється лише після retainUntil; відкритий запит не видаляється навіть при примусово простроченому retainUntil', async () => {
      const owner = await registerAccount(app, 'gc-cli')
      const shelfCancelled = await createShelfCopy(app, owner)
      const shelfOpen = await createShelfCopy(app, owner)
      const cancelledContact = await createContact(owner, 'Гість GC-cli-cancelled')
      const openContact = await createContact(owner, 'Гість GC-cli-open')
      const cancelled = await pending(owner, shelfCancelled, cancelledContact)
      const open = await pending(owner, shelfOpen, openContact)

      await cancelHandover(owner, cancelled.id).expect(200)

      const now = new Date()

      // Перед 90 днями — нічого не видаляється.
      const early = await cleanup.run(new Date(now.getTime() + 89 * DAY_MS))

      expect(early.deleted).toBe(0)
      expect(await prisma.externalBorrower.count({ where: { id: cancelledContact } })).toBe(1)

      // Примусово прострочений retainUntil у контакта з відкритим запитом — друга лінія оборони.
      await prisma.externalBorrower.update({
        where: { id: openContact },
        data: { retainUntil: new Date(now.getTime() - DAY_MS) },
      })

      const late = await cleanup.run(new Date(now.getTime() + 91 * DAY_MS))

      expect(late.deleted).toBeGreaterThanOrEqual(1)
      expect(
        await prisma.externalBorrower.findUnique({ where: { id: cancelledContact } }),
      ).toBeNull()
      expect(
        await prisma.externalBorrower.findUnique({ where: { id: openContact } }),
      ).not.toBeNull()

      // Loan/LoanEvent/підтвердження скасованої передачі лишаються без контакту.
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: cancelled.loan.id } })

      expect(loan.status).toBe('CANCELLED')
      expect(loan.borrowerContactId).toBeNull()
      expect(await prisma.loanEvent.count({ where: { loanId: loan.id } })).toBe(2)
      expect(
        (await prisma.guestLoanConfirmation.findUniqueOrThrow({ where: { id: cancelled.id } }))
          .externalBorrowerId,
      ).toBeNull()

      const openRow = await prisma.guestLoanConfirmation.findUniqueOrThrow({
        where: { id: open.id },
      })

      expect(openRow.externalBorrowerId).toBe(openContact)
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: shelfOpen.copyId } })).status,
      ).toBe('RESERVED')
    })

    it('бекфіл CLI для контакту зі скасованою передачею без retainUntil дає cancelledAt + 90д', async () => {
      const owner = await registerAccount(app, 'gc-cli-backfill')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-cli-backfill')
      const confirmation = await pending(owner, shelf, contactId)

      await cancelHandover(owner, confirmation.id).expect(200)
      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: null },
      })
      await cleanup.run(new Date())

      const event = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId: confirmation.loan.id, type: 'GUEST_HANDOVER_CANCELLED' },
      })
      const contact = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

      expect(contact.retainUntil?.getTime()).toBe(event.occurredAt.getTime() + 90 * DAY_MS)
    })
  })

  describe('приватність: нікнейм/email гостя й alias — лише власнику', () => {
    it('підтверджені гостем нікнейм/email бачить лише власник (/me/external-borrowers, /guest-loan-confirmations); alias не перезаписано', async () => {
      const owner = await registerAccount(app, 'gc-priv-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Аліас-Власника-GC')
      const confirmation = await pending(owner, shelf, contactId)
      const verifiedAt = new Date('2026-09-29T10:00:00.000Z')

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: {
          guestNickname: 'Нікнейм-Гостя-GC',
          guestEmail: 'gc-priv@guest.invalid',
          guestEmailVerifiedAt: verifiedAt,
        },
      })

      const contacts = await request(http())
        .get(url('/me/external-borrowers'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const contact = externalBorrowerListResponseSchema
        .parse(contacts.body)
        .contacts.find((item) => item.id === contactId)

      expect(contact).toMatchObject({
        alias: 'Аліас-Власника-GC',
        guestNickname: 'Нікнейм-Гостя-GC',
        guestEmail: 'gc-priv@guest.invalid',
        guestEmailVerifiedAt: verifiedAt.toISOString(),
      })

      const got = await getConfirmation(owner, confirmation.id).expect(200)

      expect(guestLoanConfirmationResponseSchema.parse(got.body).confirmation.contact).toEqual({
        id: contactId,
        alias: 'Аліас-Власника-GC',
        guestNickname: 'Нікнейм-Гостя-GC',
        guestEmail: 'gc-priv@guest.invalid',
        guestEmailVerifiedAt: verifiedAt.toISOString(),
      })

      // Зміна alias власником не чіпає гостьові значення й навпаки.
      await request(http())
        .patch(url(`/me/external-borrowers/${contactId}`))
        .set('Cookie', owner.cookie)
        .send({ alias: 'Нова-Аліас-GC' })
        .expect(200)

      const after = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

      expect(after).toMatchObject({ alias: 'Нова-Аліас-GC', guestNickname: 'Нікнейм-Гостя-GC' })
    })

    it('друг, сторонній і власник на публічних/спільних поверхнях не отримують alias, нікнейм, email чи id контакту', async () => {
      const owner = await registerAccount(app, 'gc-leak-owner')
      const friend = await registerAccount(app, 'gc-leak-friend')
      const stranger = await registerAccount(app, 'gc-leak-stranger')

      await befriend(app, owner, friend)
      await request(http())
        .patch(url('/me'))
        .set('Cookie', owner.cookie)
        .send({ showHolderNames: true })
        .expect(200)

      const shelf = await createShelfCopy(app, owner, 'PUBLIC')
      const contactId = await createContact(owner, 'Аліас-Витік-GC')
      const confirmation = await pending(owner, shelf, contactId)

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: {
          guestNickname: 'Нікнейм-Витік-GC',
          guestEmail: 'leak-gc@guest.invalid',
          guestEmailVerifiedAt: new Date(),
        },
      })

      const secrets = [
        'Аліас-Витік-GC',
        'Нікнейм-Витік-GC',
        'leak-gc@guest.invalid',
        contactId,
        'guestNickname',
        'guestEmail',
      ]
      const surfaces: [Account, string][] = [
        [friend, `/works/${shelf.workId}/history`],
        [friend, `/copies/${shelf.copyId}/history`],
        [friend, `/works/${shelf.workId}/holders`],
        [friend, `/users/${owner.id}/library`],
        [friend, '/me/history'],
        [friend, '/loans?role=borrower'],
        [friend, '/me/notifications'],
        [stranger, `/works/${shelf.workId}/history`],
        [stranger, `/users/${owner.id}/library`],
        [owner, '/loans?role=owner'],
        [owner, '/loans/guest'],
        [owner, '/me/notifications'],
        [owner, '/me/library'],
        [owner, `/copies/${shelf.copyId}/history`],
        [owner, '/me/history'],
      ]

      for (const [account, path] of surfaces) {
        const response = await request(http()).get(url(path)).set('Cookie', account.cookie)
        const raw = JSON.stringify(response.body)

        for (const secret of secrets) {
          expect({ path, leaked: raw.includes(secret) }).toEqual({ path, leaked: false })
        }
      }

      // Чужий ресурс і стороннього, і друга — 404 / порожньо.
      for (const outsider of [friend, stranger]) {
        expect((await getConfirmation(outsider, confirmation.id)).status).toBe(404)

        const list = await request(http())
          .get(url('/guest-loan-confirmations'))
          .set('Cookie', outsider.cookie)
          .expect(200)

        expect(JSON.stringify(list.body)).not.toContain('Нікнейм-Витік-GC')
      }
    })

    it('очікуваний і скасований запити не стають публічним фактом передачі (workHistory) і не видимі другові в історії примірника; власник у /me/history бачить джерело', async () => {
      const owner = await registerAccount(app, 'gc-public-owner')
      const friend = await registerAccount(app, 'gc-public-friend')

      await befriend(app, owner, friend)

      const pendingShelf = await createShelfCopy(app, owner)
      const cancelledShelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-public')
      const openRequest = await pending(owner, pendingShelf, contactId)
      const cancelledRequest = await pending(owner, cancelledShelf, contactId)

      await cancelHandover(owner, cancelledRequest.id).expect(200)

      for (const shelf of [pendingShelf, cancelledShelf]) {
        const work = await request(http())
          .get(url(`/works/${shelf.workId}/history`))
          .set('Cookie', friend.cookie)
          .expect(200)

        expect(workHistoryResponseSchema.parse(work.body).entries).toEqual([])

        const copy = await request(http())
          .get(url(`/copies/${shelf.copyId}/history`))
          .set('Cookie', friend.cookie)
          .expect(200)

        expect(copyHistoryResponseSchema.parse(copy.body).entries).toEqual([])
      }

      const mine = await request(http())
        .get(url('/me/history'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const lent = myHistoryResponseSchema.parse(mine.body).lent
      const evidences = lent
        .filter((item) => [pendingShelf.copyId, cancelledShelf.copyId].includes(item.copy.id))
        .map((item) => [item.copy.id, item.entry.status, item.entry.guestEvidence])

      expect(evidences).toEqual(
        expect.arrayContaining([
          [pendingShelf.copyId, 'PENDING_CONFIRMATION', 'AWAITING_GUEST'],
          [cancelledShelf.copyId, 'CANCELLED', null],
        ]),
      )
      expect(openRequest.loan.status).toBe('PENDING_CONFIRMATION')

      // Після запису зі слів власника факт публічний, але джерело — «зі слів власника».
      await recordStatement(owner, openRequest.id).expect(200)

      const publicWork = await request(http())
        .get(url(`/works/${pendingShelf.workId}/history`))
        .set('Cookie', friend.cookie)
        .expect(200)
      const entries = workHistoryResponseSchema.parse(publicWork.body).entries

      expect(entries).toHaveLength(1)
      expect(entries[0]?.entry.origin).toBe('RECORDED_GUEST')
      expect(entries[0]?.entry.guestEvidence).toBe('OWNER_STATEMENT')
      expect(entries[0]?.entry.names).toBe(false)
    })

    it('старий ручний запис 10f.3 у workHistory має guestEvidence = OWNER_STATEMENT; звичайна позика — null', async () => {
      const owner = await registerAccount(app, 'gc-history-legacy')
      const friend = await registerAccount(app, 'gc-history-legacy-friend')

      await befriend(app, owner, friend)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-history-legacy')

      await request(http())
        .post(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
        .expect(201)

      const response = await request(http())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', friend.cookie)
        .expect(200)
      const entries = workHistoryResponseSchema.parse(response.body).entries

      expect(entries.map((item) => item.entry.guestEvidence)).toEqual(['OWNER_STATEMENT'])
    })
  })

  describe('гонки create / cancel / record / delete', () => {
    it('create ∥ create на той самий Copy — рівно один 201, другий 409, один рядок підтвердження', async () => {
      const owner = await registerAccount(app, 'gc-race-create')
      const shelf = await createShelfCopy(app, owner)
      const contactOne = await createContact(owner, 'Гість GC-race-1')
      const contactTwo = await createContact(owner, 'Гість GC-race-2')
      const body = (externalBorrowerId: string): Record<string, unknown> => ({
        copyId: shelf.copyId,
        externalBorrowerId,
        handedAt: '2026-01-01',
      })

      const responses = await Promise.all([
        createConfirmation(owner, body(contactOne)),
        createConfirmation(owner, body(contactTwo)),
      ])

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
      expect(
        await prisma.guestLoanConfirmation.count({ where: { loan: { copyId: shelf.copyId } } }),
      ).toBe(1)
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(1)
    })

    it('create ∥ ручний POST /loans/guest на той самий Copy — рівно один переможець', async () => {
      const owner = await registerAccount(app, 'gc-race-manual')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-race-manual')
      const body = { copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' }

      const responses = await Promise.all([
        createConfirmation(owner, body),
        request(http()).post(url('/loans/guest')).set('Cookie', owner.cookie).send(body),
      ])

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(1)
    })

    it('cancel ∥ record на один запит — рівно одна дія виграє, інша 409; стан узгоджений', async () => {
      for (let round = 0; round < 3; round += 1) {
        const owner = await registerAccount(app, `gc-race-cr-${String(round)}`)
        const shelf = await createShelfCopy(app, owner)
        const contactId = await createContact(owner, 'Гість GC-race-cr')
        const confirmation = await pending(owner, shelf, contactId)

        const [cancelResponse, recordResponse] = await Promise.all([
          cancelHandover(owner, confirmation.id),
          recordStatement(owner, confirmation.id),
        ])

        expect([cancelResponse.status, recordResponse.status].sort()).toEqual([200, 409])

        const row = await prisma.guestLoanConfirmation.findUniqueOrThrow({
          where: { id: confirmation.id },
          include: { loan: { include: { copy: true } } },
        })

        if (cancelResponse.status === 200) {
          expect(row.status).toBe('CANCELLED')
          expect(row.loan.status).toBe('CANCELLED')
          expect(row.loan.copy.status).toBe('AVAILABLE')
        } else {
          expect(row.status).toBe('OWNER_RECORDED')
          expect(row.loan.status).toBe('HANDED_OVER')
          expect(row.loan.copy.status).toBe('LENT_OUT')
        }

        const types = (await prisma.loanEvent.findMany({ where: { loanId: row.loanId } })).map(
          (event) => event.type,
        )

        expect(types).toHaveLength(2)
      }
    })

    it('cancel ∥ cancel — рівно одна подія скасування, другий 409', async () => {
      const owner = await registerAccount(app, 'gc-race-cc')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-race-cc')
      const confirmation = await pending(owner, shelf, contactId)

      const responses = await Promise.all([
        cancelHandover(owner, confirmation.id),
        cancelHandover(owner, confirmation.id),
      ])

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
      expect(
        await prisma.loanEvent.count({
          where: { loanId: confirmation.loan.id, type: 'GUEST_HANDOVER_CANCELLED' },
        }),
      ).toBe(1)
    })

    it('cancel ∥ DELETE контакту: DELETE не проходить раніше скасування; жодного 500, інваріанти зберігаються', async () => {
      for (let round = 0; round < 3; round += 1) {
        const owner = await registerAccount(app, `gc-race-cd-${String(round)}`)
        const shelf = await createShelfCopy(app, owner)
        const contactId = await createContact(owner, 'Гість GC-race-cd')
        const confirmation = await pending(owner, shelf, contactId)

        const [cancelResponse, deleteResponse] = await Promise.all([
          cancelHandover(owner, confirmation.id),
          deleteContact(owner, contactId),
        ])

        expect(cancelResponse.status).toBe(200)
        expect([204, 409]).toContain(deleteResponse.status)

        const loan = await prisma.loan.findUniqueOrThrow({ where: { id: confirmation.loan.id } })
        const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

        // Ніколи: контакт стерто, а позика лишилась активною/Copy зависла в RESERVED без тримача.
        expect(loan.status).toBe('CANCELLED')
        expect(copy.status).toBe('AVAILABLE')

        if (deleteResponse.status === 204) {
          expect(loan.borrowerContactId).toBeNull()
        } else {
          expect(loan.borrowerContactId).toBe(contactId)
        }
      }
    })

    it('record ∥ DELETE контакту: DELETE не проходить, поки позика активна; запис завжди успішний', async () => {
      const owner = await registerAccount(app, 'gc-race-rd')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-race-rd')
      const confirmation = await pending(owner, shelf, contactId)

      const [recordResponse, deleteResponse] = await Promise.all([
        recordStatement(owner, confirmation.id),
        deleteContact(owner, contactId),
      ])

      expect(recordResponse.status).toBe(200)
      expect(deleteResponse.status).toBe(409)
      expect(errorCode(deleteResponse.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')
      expect(await prisma.externalBorrower.findUnique({ where: { id: contactId } })).not.toBeNull()
    })

    it('create ∥ DELETE контакту: або 201 і DELETE 409, або DELETE 204 і create 404 — ніколи активна позика без контакту', async () => {
      for (let round = 0; round < 3; round += 1) {
        const owner = await registerAccount(app, `gc-race-xd-${String(round)}`)
        const shelf = await createShelfCopy(app, owner)
        const contactId = await createContact(owner, 'Гість GC-race-xd')

        const [createResponse, deleteResponse] = await Promise.all([
          createConfirmation(owner, {
            copyId: shelf.copyId,
            externalBorrowerId: contactId,
            handedAt: '2026-01-01',
          }),
          deleteContact(owner, contactId),
        ])

        expect(createResponse.status === 201 || createResponse.status === 404).toBe(true)
        expect([204, 409]).toContain(deleteResponse.status)

        if (createResponse.status === 201) {
          expect(deleteResponse.status).toBe(409)
          expect(
            await prisma.externalBorrower.findUnique({ where: { id: contactId } }),
          ).not.toBeNull()
        } else {
          expect(deleteResponse.status).toBe(204)
          expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)
        }

        const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

        expect(copy.status).toBe(createResponse.status === 201 ? 'RESERVED' : 'AVAILABLE')
      }
    })

    it('cancel ∥ CLI-чистка: контакт із відкритим запитом не видаляється, скасований — лише після прострочення', async () => {
      const owner = await registerAccount(app, 'gc-race-cli')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-race-cli')
      const confirmation = await pending(owner, shelf, contactId)

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: new Date(Date.now() - DAY_MS) },
      })

      await Promise.all([cancelHandover(owner, confirmation.id), cleanup.run(new Date())])

      // Після скасування retainUntil = cancelledAt + 90д у майбутньому: чистка або відхилила контакт
      // (відкритий запит), або перерахунок скасування переписав прострочену межу.
      const contact = await prisma.externalBorrower.findUnique({ where: { id: contactId } })

      expect(contact).not.toBeNull()
      expect(contact?.retainUntil?.getTime()).toBeGreaterThan(Date.now())
      expect((await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).status).toBe(
        'AVAILABLE',
      )
    })

    it('deferred: cancel, заблокований на локу ExternalBorrower, чекає й потім завершується (порядок EB → Copy → Loan → GuestLoanConfirmation)', async () => {
      const owner = await registerAccount(app, 'gc-race-lock')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GC-race-lock')
      const confirmation = await pending(owner, shelf, contactId)
      const holder = new Client({ connectionString: testDatabaseUrl() })

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "ExternalBorrower" WHERE "id" = $1 FOR UPDATE', [
          contactId,
        ])

        const cancelling = beginRequest(cancelHandover(owner, confirmation.id))

        await waitForBlockedBackend(prisma, { expectedCount: 1 })

        // Поки перший ресурс порядку зайнятий, нічого нижче (Copy/Loan/підтвердження) не заторкнуто.
        expect(
          (await prisma.guestLoanConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } }))
            .status,
        ).toBe('OPEN')

        await holder.query('COMMIT')

        const response = await cancelling

        expect(response.status).toBe(200)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    })
  })
})
