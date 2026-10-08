import './helpers/guest-loans-on'
import 'reflect-metadata'
import request from 'supertest'
import {
  apiErrorSchema,
  externalBorrowerResponseSchema,
  guestLoanListResponseSchema,
  guestLoanResponseSchema,
  myHistoryResponseSchema,
  workHistoryResponseSchema,
  type ApiErrorCode,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  approvedLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10f.3 (docs/plan/stage-10-real-world-history.md, §6.2, §6.4, §6.9, §6.11.1, GL1–GL6,
 * P1–P5). Лише синтетичні дані (D2 відкритий release blocker).
 */
describe('Stage 10 (10f.3): гостьова позика (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): ApiErrorCode => apiErrorSchema.parse(body).code

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
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

  async function handedOverGuestLoan(
    owner: Account,
    shelf: Shelf,
    contactId: string,
  ): Promise<string> {
    const response = await createGuestLoan(owner, {
      copyId: shelf.copyId,
      externalBorrowerId: contactId,
      handedAt: '2026-01-01',
    }).expect(201)

    return guestLoanResponseSchema.parse(response.body).loan.id
  }

  async function lostGuestLoan(owner: Account, shelf: Shelf, contactId: string): Promise<string> {
    const loanId = await handedOverGuestLoan(owner, shelf, contactId)

    await actOnGuestLoan(owner, loanId, { action: 'mark_lost' }).expect(200)

    return loanId
  }

  describe('GL1: створення без User', () => {
    it('Copy → LENT_OUT з heldByContactId, без currentHolderId; return власником повертає Copy додому', async () => {
      const owner = await registerAccount(app, 'gl1-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL1')

      const loanId = await handedOverGuestLoan(owner, shelf, contactId)
      const copyAfterCreate = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copyAfterCreate.status).toBe('LENT_OUT')
      expect(copyAfterCreate.currentHolderId).toBeNull()
      expect(copyAfterCreate.heldByContactId).toBe(contactId)

      const loanRow = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loanRow.borrowerId).toBeNull()
      expect(loanRow.borrowerKind).toBe('GUEST')
      expect(loanRow.origin).toBe('RECORDED_GUEST')
      expect(loanRow.requestedAt).toBeNull()
      expect(loanRow.status).toBe('HANDED_OVER')

      const returned = await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)
      const loan = guestLoanResponseSchema.parse(returned.body).loan

      expect(loan.status).toBe('RETURNED')
      expect(loan.returnedAt).not.toBeNull()

      const copyAfterReturn = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copyAfterReturn.status).toBe('AVAILABLE')
      expect(copyAfterReturn.currentHolderId).toBe(owner.id)
      expect(copyAfterReturn.heldByContactId).toBeNull()
    })

    it('mark_lost: Copy → UNAVAILABLE, heldByContactId лишається на контакті', async () => {
      const owner = await registerAccount(app, 'gl1-lost')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL1b')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(loan.status).toBe('LOST')
      expect(copy.status).toBe('UNAVAILABLE')
      expect(copy.heldByContactId).toBe(contactId)
    })
  })

  describe('GL2: обов’язковий alias; note/message відхиляються', () => {
    it('зайве поле message/note у POST /loans/guest → 400, нічого не створено', async () => {
      const owner = await registerAccount(app, 'gl2-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL2')

      const response = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
        message: 'вітаю',
      })

      expect(response.status).toBe(400)
      expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)
    })

    it('дії гостьового PATCH — лише return/mark_lost/recover/close_loss', async () => {
      const owner = await registerAccount(app, 'gl2-actions')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL2b')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      for (const action of ['approve', 'confirm_record', 'hand_over']) {
        const response = await actOnGuestLoan(owner, loanId, { action })

        expect(response.status).toBe(400)
      }
    })
  })

  describe('GL3: контакт власника A недоступний власнику B', () => {
    it('чужий контакт у POST /loans/guest → 404, нічого не створено', async () => {
      const ownerA = await registerAccount(app, 'gl3-a')
      const ownerB = await registerAccount(app, 'gl3-b')
      const contactOfA = await createContact(ownerA, 'Контакт A')
      const shelfOfB = await createShelfCopy(app, ownerB)

      const response = await createGuestLoan(ownerB, {
        copyId: shelfOfB.copyId,
        externalBorrowerId: contactOfA,
        handedAt: '2026-01-01',
      })

      expect(response.status).toBe(404)
      expect(errorCode(response.body)).toBe('NOT_FOUND')
      expect(await prisma.loan.count({ where: { copyId: shelfOfB.copyId } })).toBe(0)
    })

    it('чужий Copy з власним контактом → 404', async () => {
      const ownerA = await registerAccount(app, 'gl3-c')
      const ownerB = await registerAccount(app, 'gl3-d')
      const contactOfB = await createContact(ownerB, 'Контакт B')
      const shelfOfA = await createShelfCopy(app, ownerA)

      const response = await createGuestLoan(ownerB, {
        copyId: shelfOfA.copyId,
        externalBorrowerId: contactOfB,
        handedAt: '2026-01-01',
      })

      expect(response.status).toBe(404)
    })

    it('чужа гостьова позика в PATCH/GET /loans/guest/:id → 404', async () => {
      const owner = await registerAccount(app, 'gl3-owner')
      const stranger = await registerAccount(app, 'gl3-stranger')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL3')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await request(http())
        .get(url(`/loans/guest/${loanId}`))
        .set('Cookie', stranger.cookie)
        .expect(404)
      await actOnGuestLoan(stranger, loanId, { action: 'return' }).expect(404)
    })
  })

  describe('GL5: recover для гостьової позики', () => {
    it('однократність: перший 200, другий 409 LOAN_ALREADY_RECOVERED; Copy повертається власнику', async () => {
      const owner = await registerAccount(app, 'gl5-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL5')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const first = await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)
      const loan = guestLoanResponseSchema.parse(first.body).loan

      expect(loan.status).toBe('LOST')
      expect(loan.recovery).not.toBeNull()

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('AVAILABLE')
      expect(copy.currentHolderId).toBe(owner.id)
      expect(copy.heldByContactId).toBeNull()

      const second = await actOnGuestLoan(owner, loanId, { action: 'recover' })

      expect(second.status).toBe(409)
      expect(errorCode(second.body)).toBe('LOAN_ALREADY_RECOVERED')
    })

    it('recover дозволений і після close_loss (Q3c)', async () => {
      const owner = await registerAccount(app, 'gl5-after-close')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL5b')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)

      const recovered = await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)
      const loan = guestLoanResponseSchema.parse(recovered.body).loan

      expect(loan.recovery).not.toBeNull()
      expect(loan.lossClosure).not.toBeNull()
    })
  })

  describe('GL6: «Закрити втрату» (close_loss)', () => {
    it('пише лише LoanEvent LOSS_CLOSED; Loan.status лишається LOST; Copy й дати незмінні', async () => {
      const owner = await registerAccount(app, 'gl6-owner')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL6')
      const loanId = await lostGuestLoan(owner, shelf, contactId)
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })
      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      const response = await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
      const loan = guestLoanResponseSchema.parse(response.body).loan

      expect(loan.status).toBe('LOST')
      expect(loan.lossClosure).not.toBeNull()

      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore)
    })

    it('доступна для архівного примірника (на відміну від recover)', async () => {
      const owner = await registerAccount(app, 'gl6-archived')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL6b')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await request(http())
        .post(url(`/me/library/${shelf.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)

      const recoverAttempt = await actOnGuestLoan(owner, loanId, { action: 'recover' })

      expect(recoverAttempt.status).toBe(409)
      expect(errorCode(recoverAttempt.body)).toBe('COPY_ARCHIVED')

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
    })

    it('повторний close_loss або після RECOVERED → 409 LOAN_ALREADY_CLOSED, без побічного ефекту', async () => {
      const owner = await registerAccount(app, 'gl6-repeat')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL6c')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
      const repeat = await actOnGuestLoan(owner, loanId, { action: 'close_loss' })

      expect(repeat.status).toBe(409)
      expect(errorCode(repeat.body)).toBe('LOAN_ALREADY_CLOSED')

      const otherOwner = await registerAccount(app, 'gl6-after-recover')
      const otherShelf = await createShelfCopy(app, otherOwner)
      const otherContact = await createContact(otherOwner, 'Гість GL6d')
      const otherLoanId = await lostGuestLoan(otherOwner, otherShelf, otherContact)

      await actOnGuestLoan(otherOwner, otherLoanId, { action: 'recover' }).expect(200)
      const afterRecover = await actOnGuestLoan(otherOwner, otherLoanId, { action: 'close_loss' })

      expect(afterRecover.status).toBe(409)
      expect(errorCode(afterRecover.body)).toBe('LOAN_ALREADY_CLOSED')
    })

    it('не для HANDED_OVER (лише LOST) → 409 LOAN_INVALID_TRANSITION', async () => {
      const owner = await registerAccount(app, 'gl6-invalid')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість GL6e')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      const response = await actOnGuestLoan(owner, loanId, { action: 'close_loss' })

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_INVALID_TRANSITION')
    })
  })

  describe('Розширена модель передумов тримача (§6.11.2 execution plan)', () => {
    it('невідповідний heldByContactId → 409 LOAN_COPY_STATE_MISMATCH, а не тихий успіх', async () => {
      const owner = await registerAccount(app, 'holder-mismatch')
      const shelf = await createShelfCopy(app, owner)
      const contactA = await createContact(owner, 'Контакт A holder')
      const contactB = await createContact(owner, 'Контакт B holder')
      const loanId = await handedOverGuestLoan(owner, shelf, contactA)

      // Зіпсовані дані: Copy тепер каже, що книжку тримає інший контакт, ніж записано в Loan.
      await prisma.copy.update({
        where: { id: shelf.copyId },
        data: { heldByContactId: contactB },
      })

      const response = await actOnGuestLoan(owner, loanId, { action: 'return' })

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_COPY_STATE_MISMATCH')
    })

    it('recovery не вимагає, щоб контакт існував: обидва heldByContactId/borrowerContactId NULL — теж «збігаються»', async () => {
      const owner = await registerAccount(app, 'holder-null')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Контакт для стирання')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
      await request(http())
        .delete(url(`/me/external-borrowers/${contactId}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const loanRow = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const copyRow = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(loanRow.borrowerContactId).toBeNull()
      expect(copyRow.heldByContactId).toBeNull()

      const recovered = await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)
      const loan = guestLoanResponseSchema.parse(recovered.body).loan

      expect(loan.recovery).not.toBeNull()
      expect(loan.contact).toBeNull()

      const copyAfter = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copyAfter.status).toBe('AVAILABLE')
      expect(copyAfter.currentHolderId).toBe(owner.id)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('регресія: стара гостьова втрата закрита й контакт стерто, але currentHolderId зіпсовано вказує на зареєстрованого позичальника — recovery відмовляє', async () => {
      const owner = await registerAccount(app, 'holder-null-corrupted')
      const registeredBorrower = await registerAccount(app, 'holder-null-corrupted-b')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Контакт для стирання-2')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)
      await request(http())
        .delete(url(`/me/external-borrowers/${contactId}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      // Обидва contact-поля тепер NULL (як у попередньому тесті) — за старою логікою («лише
      // heldByContactId === borrowerContactId») цього було б достатньо для успішної recovery.
      // Але дані зіпсовані іншим шляхом: currentHolderId вказує на когось стороннього (наприклад,
      // залишок від зовсім іншої, пізнішої — навіть гіпотетично неможливої за нормальним потоком —
      // операції). `recover` не має мовчки «повернути» книжку власнику, коли Copy насправді вже
      // (за даними) в руках зареєстрованого користувача.
      await prisma.copy.update({
        where: { id: shelf.copyId },
        data: { currentHolderId: registeredBorrower.id },
      })

      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })
      const eventsBefore = await prisma.loanEvent.findMany({ where: { loanId } })

      const response = await actOnGuestLoan(owner, loanId, { action: 'recover' })

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_COPY_STATE_MISMATCH')
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loanEvent.findMany({ where: { loanId } })).toEqual(eventsBefore)
      expect(eventsBefore.some((event) => event.type === 'RECOVERED')).toBe(false)
    })
  })

  describe('Owner-only GET /loans/guest[/:id] — контракт і доступ після DELETE', () => {
    it('list і get віддають alias власнику; contact=null після видалення контакту', async () => {
      const owner = await registerAccount(app, 'owner-only-list')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Аліас Owner-Only')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      const listResponse = await request(http())
        .get(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const { loans } = guestLoanListResponseSchema.parse(listResponse.body)

      expect(loans).toHaveLength(1)
      expect(loans[0]?.contact).toEqual({ id: contactId, alias: 'Аліас Owner-Only' })

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)
      await request(http())
        .delete(url(`/me/external-borrowers/${contactId}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const getAfterDelete = await request(http())
        .get(url(`/loans/guest/${loanId}`))
        .set('Cookie', owner.cookie)
        .expect(200)
      const loan = guestLoanResponseSchema.parse(getAfterDelete.body).loan

      expect(loan.contact).toBeNull()
      expect(loan.status).toBe('RETURNED')
    })
  })

  /**
   * Item 3 (рев'ю): CHECK `loan_borrower_kind_valid` обмежує лише `borrowerId`/`borrowerContactId`
   * відносно `borrowerKind` — він НЕ забороняє `borrowerKind='GUEST'` зі `status='REQUESTED'` чи
   * будь-яким іншим статусом поза `{HANDED_OVER, RETURNED, LOST}`. Такий рядок вставляється напряму
   * (в обхід застосунку) — це доводить, що фільтр тримає сам код читачів, а не сама лише БД.
   */
  describe('Межа валідних гостьових рядків (§6.2.3 execution plan)', () => {
    async function insertSyntheticGuestRow(owner: Account, shelf: Shelf, contactId: string) {
      return prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: null,
          borrowerKind: 'GUEST',
          origin: 'RECORDED_GUEST',
          borrowerContactId: contactId,
          status: 'REQUESTED',
          requestedAt: null,
          handedAt: null,
        },
      })
    }

    it('невалідний синтетичний рядок (status=REQUESTED) не потрапляє в list', async () => {
      const owner = await registerAccount(app, 'invalid-row-list')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість invalid-row')

      await insertSyntheticGuestRow(owner, shelf, contactId)

      const response = await request(http())
        .get(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(guestLoanListResponseSchema.parse(response.body).loans).toEqual([])
    })

    it('GET /loans/guest/:id для невалідного синтетичного рядка → 404', async () => {
      const owner = await registerAccount(app, 'invalid-row-get')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість invalid-row-get')
      const synthetic = await insertSyntheticGuestRow(owner, shelf, contactId)

      await request(http())
        .get(url(`/loans/guest/${synthetic.id}`))
        .set('Cookie', owner.cookie)
        .expect(404)
    })

    it('PATCH /loans/guest/:id для невалідного синтетичного рядка → 404, без мутацій', async () => {
      const owner = await registerAccount(app, 'invalid-row-patch')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість invalid-row-patch')
      const synthetic = await insertSyntheticGuestRow(owner, shelf, contactId)
      const before = await prisma.loan.findUniqueOrThrow({ where: { id: synthetic.id } })
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      const response = await actOnGuestLoan(owner, synthetic.id, { action: 'return' })

      expect(response.status).toBe(404)
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: synthetic.id } })).toEqual(before)
      expect(await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).toEqual(
        copyBefore,
      )
      expect(await prisma.loanEvent.count({ where: { loanId: synthetic.id } })).toBe(0)
    })
  })

  describe('P1/P2: приватність гостьового факту на спільних поверхнях', () => {
    it('друг бачить гостьову позику лише анонімно у /works/:id/history, навіть при showHolderNames=true', async () => {
      const owner = await registerAccount(app, 'priv-owner')
      const friend = await registerAccount(app, 'priv-friend')

      await befriend(app, owner, friend)
      await request(http())
        .patch(url('/me'))
        .set('Cookie', owner.cookie)
        .send({ showHolderNames: true })
        .expect(200)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Аліас-Приватний-P1')
      await handedOverGuestLoan(owner, shelf, contactId)

      const response = await request(http())
        .get(url(`/works/${shelf.workId}/history`))
        .set('Cookie', friend.cookie)
        .expect(200)
      const { entries } = workHistoryResponseSchema.parse(response.body)

      expect(entries).toHaveLength(1)
      expect(entries[0]?.entry.names).toBe(false)
      expect(JSON.stringify(response.body)).not.toContain('Аліас-Приватний-P1')
    })

    it('власник у /me/history бачить анонімний факт (не губиться) без alias/contactId', async () => {
      const owner = await registerAccount(app, 'priv-me-history')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Аліас-МояІсторія-P2')
      await handedOverGuestLoan(owner, shelf, contactId)

      const response = await request(http())
        .get(url('/me/history'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const { lent } = myHistoryResponseSchema.parse(response.body)

      expect(lent).toHaveLength(1)
      expect(lent[0]?.entry.names).toBe(false)
      expect(JSON.stringify(response.body)).not.toContain('Аліас-МояІсторія-P2')
    })

    it('alias/contactId відсутні в /loans, /works/:id/holders, notifications', async () => {
      const owner = await registerAccount(app, 'priv-surfaces')
      const friend = await registerAccount(app, 'priv-surfaces-friend')

      await befriend(app, owner, friend)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Аліас-Поверхні-P2b')
      await handedOverGuestLoan(owner, shelf, contactId)

      for (const [account, path] of [
        [owner, '/loans'],
        [friend, `/works/${shelf.workId}/holders`],
        [friend, '/me/notifications'],
        [owner, '/me/notifications'],
      ] as const) {
        const response = await request(http()).get(url(path)).set('Cookie', account.cookie)

        expect(JSON.stringify(response.body)).not.toContain('Аліас-Поверхні-P2b')
        expect(JSON.stringify(response.body)).not.toContain(contactId)
      }
    })
  })

  describe('НОВЕ рішення PO: атомарне відхилення наявних REQUESTED при створенні гостьової позики', () => {
    it('усі REQUESTED (origin=REQUESTED, borrowerKind=REGISTERED) → REJECTED зі сповіщеннями', async () => {
      const owner = await registerAccount(app, 'rival-owner')
      const rivalOne = await registerAccount(app, 'rival-one')
      const rivalTwo = await registerAccount(app, 'rival-two')

      await befriend(app, owner, rivalOne)
      await befriend(app, owner, rivalTwo)

      const shelf = await createShelfCopy(app, owner)
      const requestOne = await requestLoan(app, rivalOne, shelf.copyId).expect(201)
      const requestTwo = await requestLoan(app, rivalTwo, shelf.copyId).expect(201)
      const contactId = await createContact(owner, 'Гість Rivals')

      await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      }).expect(201)

      const rivalOneLoan = await prisma.loan.findUniqueOrThrow({
        where: { id: (requestOne.body as { loan: { id: string } }).loan.id },
      })
      const rivalTwoLoan = await prisma.loan.findUniqueOrThrow({
        where: { id: (requestTwo.body as { loan: { id: string } }).loan.id },
      })

      expect(rivalOneLoan.status).toBe('REJECTED')
      expect(rivalTwoLoan.status).toBe('REJECTED')
      expect(rivalOneLoan.respondedAt).not.toBeNull()

      const notifications = await prisma.notification.findMany({
        where: { userId: { in: [rivalOne.id, rivalTwo.id] }, type: 'LOAN_REJECTED' },
      })

      expect(notifications).toHaveLength(2)
    })

    it('create ∥ registered approve на той самий Copy — рівно один переможець', async () => {
      const owner = await registerAccount(app, 'race-owner')
      const rival = await registerAccount(app, 'race-rival')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race')
      const requested = await requestLoan(app, rival, shelf.copyId).expect(201)
      const rivalLoanId = (requested.body as { loan: { id: string } }).loan.id

      // Гонка непередбачувана за задумом (переможець — хто перший захопив лок Copy в Postgres),
      // тож перевіряємо не конкретний порядок, а те, що переможець рівно один і стан узгоджений
      // із тим, хто саме виграв — без 500 і без подвійного зайняття Copy в обох випадках.
      const guestCreate = createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      })
      const approve = actOnLoan(app, owner, rivalLoanId, { action: 'approve' })

      const [createResult, approveResult] = await Promise.all([guestCreate, approve])
      const guestLoansCount = await prisma.loan.count({
        where: { copyId: shelf.copyId, borrowerKind: 'GUEST' },
      })
      const rivalLoan = await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })

      if (createResult.status === 201) {
        // guest-create переміг: rival, що ще був REQUESTED, атомарно відхилений НОВИМ рішенням PO.
        expect(approveResult.status).toBe(409)
        expect(rivalLoan.status).toBe('REJECTED')
        expect(guestLoansCount).toBe(1)
      } else {
        // rival устиг стати APPROVED першим: Copy більше не AVAILABLE, guest-create бачить його
        // зайнятим — атомарне відхилення НЕ спрацьовує заднім числом на вже APPROVED rival.
        expect(createResult.status).toBe(409)
        expect(approveResult.status).toBe(200)
        expect(rivalLoan.status).toBe('APPROVED')
        expect(guestLoansCount).toBe(0)
      }
    })
  })

  /**
   * Item 4/8 (рев'ю): це тест ВАЛІДАЦІЇ, не rollback — `assertGuestLoanDates` кидає `400` ДО
   * будь-якого запису (`INSERT`/`UPDATE`), тож тут нема чого відкочувати, і назва блоку раніше
   * помилково стверджувала протилежне. Справжні rollback-тести (ін'єкція збою ПІСЛЯ часткового
   * запису) — `guest-loans-rollback.e2e-spec.ts`.
   */
  describe('Валідація дат при створенні: 400 ДО будь-якого запису (не rollback)', () => {
    it('dueAt раніше за handedAt → 400, нічого не створено; наявний REQUESTED не зачеплено', async () => {
      const owner = await registerAccount(app, 'validation-owner')
      const rival = await registerAccount(app, 'validation-rival')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Validation')

      await requestLoan(app, rival, shelf.copyId).expect(201)

      const response = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-10',
        dueAt: '2026-01-01',
      })

      expect(response.status).toBe(400)
      expect(
        await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
      ).toBe(0)

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('AVAILABLE')

      const rivalLoan = await prisma.loan.findFirstOrThrow({
        where: { copyId: shelf.copyId, borrowerId: rival.id },
      })

      expect(rivalLoan.status).toBe('REQUESTED')
    })
  })

  describe('Regресія: реєстрований PATCH /loans/:id не бачить гостьових позик', () => {
    it('GET/PATCH /loans/:id для гостьової позики → 404, як і раніше (10d-межа)', async () => {
      const owner = await registerAccount(app, 'guest-regression')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Regression')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await request(http())
        .get(url(`/loans/${loanId}`))
        .set('Cookie', owner.cookie)
        .expect(404)
      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(404)

      const listResponse = await request(http())
        .get(url('/loans'))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(JSON.stringify(listResponse.body)).not.toContain(loanId)
    })
  })

  describe('Використання approvedLoan-хелпера лишається чинним для реєстрованого флоу', () => {
    it('sanity: approvedLoan/registered flow не зачеплені новим кодом', async () => {
      const owner = await registerAccount(app, 'sanity-owner')
      const borrower = await registerAccount(app, 'sanity-borrower')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)

      await approvedLoan(app, owner, borrower, shelf.copyId)

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('RESERVED')
    })
  })
})
