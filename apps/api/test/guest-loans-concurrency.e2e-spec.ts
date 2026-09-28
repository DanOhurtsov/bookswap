import './helpers/guest-loans-on'
import 'reflect-metadata'
import { Client } from 'pg'
import request from 'supertest'
import {
  apiErrorSchema,
  externalBorrowerResponseSchema,
  guestLoanResponseSchema,
  type ApiErrorCode,
} from '@bookswap/shared'
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
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10f.3 (§6.11.2 execution plan): контрольовані гонки, які довели необхідність
 * виправленої таблиці локів (спільний лок `Loan` для `recover`/`close_loss`; глобальний порядок
 * `ExternalBorrower → Copy → Loan` для `create`/`DELETE`).
 */
describe('Stage 10 (10f.3): конкурентність гостьових позик і чистки контакту (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let sessions: Client[]

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

  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): ApiErrorCode => apiErrorSchema.parse(body).code

  async function session(): Promise<Client> {
    const client = new Client({ connectionString: testDatabaseUrl() })

    await client.connect()
    sessions.push(client)

    return client
  }

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

  const deleteContact = (account: Account, id: string): request.Test =>
    request(http())
      .delete(url(`/me/external-borrowers/${id}`))
      .set('Cookie', account.cookie)

  const archiveCopy = (account: Account, copyId: string): request.Test =>
    request(http())
      .post(url(`/me/library/${copyId}/archive`))
      .set('Cookie', account.cookie)

  const deleteCopy = (account: Account, copyId: string): request.Test =>
    request(http())
      .delete(url(`/me/library/${copyId}`))
      .set('Cookie', account.cookie)

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

  describe('recover ∥ close_loss — спільний лок Loan (§6.11.2)', () => {
    it('порядок «recover перший»: close_loss, заблокований на тому самому Loan, після розблокування бачить RECOVERED → 409', async () => {
      const owner = await registerAccount(app, 'race-rc-1')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race RC1')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      // Той самий явний лок, що бере `GuestLoanService.applyTransition` для recover/close_loss
      // (крок 3, §6.11.2) — тримаючи його зовні, ми відтворюємо «recover ще не закомітився».
      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId])

      const closeLoss = beginRequest(actOnGuestLoan(owner, loanId, { action: 'close_loss' }))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })

      // Симулюємо ефект recover, що «виграв» лок першим: подія RECOVERED комітиться раніше, ніж
      // close_loss встигає прочитати стан.
      await holder.query(
        `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ('race-rc1-recovered', $1, 'RECOVERED')`,
        [loanId],
      )
      await holder.query('COMMIT')

      const response = await closeLoss

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('LOAN_ALREADY_CLOSED')

      // close_loss, побачивши RECOVERED, не написав LOSS_CLOSED (GUEST_LOAN_RECORDED/LOAN_LOST —
      // від самого створення й mark_lost, не від цього тесту).
      const closureEvents = await prisma.loanEvent.findMany({
        where: { loanId, type: { in: ['RECOVERED', 'LOSS_CLOSED'] } },
      })

      expect(closureEvents.map((event) => event.type).sort()).toEqual(['RECOVERED'])
    })

    it('порядок «close_loss перший»: recover, заблокований на тому самому Loan, після розблокування все одно успішний (Q3c)', async () => {
      const owner = await registerAccount(app, 'race-rc-2')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race RC2')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId])

      const recover = beginRequest(actOnGuestLoan(owner, loanId, { action: 'recover' }))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })

      // Симулюємо ефект close_loss, що «виграв» лок першим.
      await holder.query(
        `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ('race-rc2-closed', $1, 'LOSS_CLOSED')`,
        [loanId],
      )
      await holder.query('COMMIT')

      const response = await recover

      expect(response.status).toBe(200)
      const loan = guestLoanResponseSchema.parse(response.body).loan

      expect(loan.recovery).not.toBeNull()
      expect(loan.lossClosure).not.toBeNull()

      const closureEvents = await prisma.loanEvent.findMany({
        where: { loanId, type: { in: ['RECOVERED', 'LOSS_CLOSED'] } },
      })

      expect(closureEvents.map((event) => event.type).sort()).toEqual(['LOSS_CLOSED', 'RECOVERED'])

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('AVAILABLE')
      expect(copy.currentHolderId).toBe(owner.id)
    })

    it('без спільного локу цей тест ловить регресію: одночасні recover∥close_loss дають рівно по одній події кожного типу, без 500', async () => {
      const owner = await registerAccount(app, 'race-rc-3')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race RC3')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const [recoverResponse, closeLossResponse] = await Promise.all([
        actOnGuestLoan(owner, loanId, { action: 'recover' }),
        actOnGuestLoan(owner, loanId, { action: 'close_loss' }),
      ])

      // Обидва результати легітимні (recover завжди проходить; close_loss проходить, лише якщо
      // встиг до recover) — але жодного 500, і жодного дубля тієї самої події.
      expect([200, 409]).toContain(recoverResponse.status)
      expect([200, 409]).toContain(closeLossResponse.status)

      const events = await prisma.loanEvent.findMany({ where: { loanId } })
      const recoveredCount = events.filter((event) => event.type === 'RECOVERED').length
      const closedCount = events.filter((event) => event.type === 'LOSS_CLOSED').length

      expect(recoveredCount).toBeLessThanOrEqual(1)
      expect(closedCount).toBeLessThanOrEqual(1)
      expect(recoverResponse.status).toBe(200)
    })
  })

  describe('DELETE ∥ recover/close_loss — реальний FK SET NULL', () => {
    it('DELETE блокується на Copy, доки recover/close_loss не завершиться; після — 204 і реальний SET NULL на Copy.heldByContactId', async () => {
      const owner = await registerAccount(app, 'race-del-1')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race DEL1')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      // Перший лок `recover`/`close_loss` (§6.11.2) — Copy через JOIN з Loan.
      await holder.query('BEGIN')
      await holder.query(
        `SELECT c."id" FROM "Loan" l JOIN "Copy" c ON c."id" = l."copyId" WHERE l."id" = $1 FOR UPDATE OF c`,
        [loanId],
      )

      const deletion = beginRequest(deleteContact(owner, contactId))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })

      // Симулюємо «close_loss устиг закритися, поки DELETE чекав» — Copy лишається як був
      // (close_loss його не чіпає, §0.7.1), лише LoanEvent з'являється.
      await holder.query(
        `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ('race-del1-closed', $1, 'LOSS_CLOSED')`,
        [loanId],
      )
      await holder.query('COMMIT')

      const response = await deletion

      expect(response.status).toBe(204)

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const contactCount = await prisma.externalBorrower.count({ where: { id: contactId } })

      // Реальний ON DELETE SET NULL: Copy й Loan досі «пам'ятали» контакт (close_loss його не
      // чіпає), а після DELETE обидва посилання обнулені — і Loan/LoanEvent самі лишилися.
      expect(copy.heldByContactId).toBeNull()
      expect(loan.borrowerContactId).toBeNull()
      expect(loan.borrowerKind).toBe('GUEST')
      expect(loan.status).toBe('LOST')
      expect(contactCount).toBe(0)
      expect(await prisma.loanEvent.count({ where: { loanId, type: 'LOSS_CLOSED' } })).toBe(1)
    })

    it('DELETE, розблокований, але втрата все ще незакрита → 409 EXTERNAL_BORROWER_HAS_UNRESOLVED_LOSS, контакт лишається', async () => {
      const owner = await registerAccount(app, 'race-del-2')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Race DEL2')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query(
        `SELECT c."id" FROM "Loan" l JOIN "Copy" c ON c."id" = l."copyId" WHERE l."id" = $1 FOR UPDATE OF c`,
        [loanId],
      )

      const deletion = beginRequest(deleteContact(owner, contactId))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })
      // Нічого не закриваємо — просто звільняємо лок: втрата лишається незакритою.
      await holder.query('COMMIT')

      const response = await deletion

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('EXTERNAL_BORROWER_HAS_UNRESOLVED_LOSS')
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })
  })

  describe('DELETE ∥ create — спільний лок ExternalBorrower', () => {
    it('DELETE блокується на контакті, доки не звільниться; після — програна create бачить контакт стертим (404)', async () => {
      const owner = await registerAccount(app, 'race-create-del-1')
      const contactId = await createContact(owner, 'Гість Race Create1')
      const shelf = await createShelfCopy(app, owner)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "ExternalBorrower" WHERE "id" = $1 FOR UPDATE', [
        contactId,
      ])

      const deletion = beginRequest(deleteContact(owner, contactId))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })
      await holder.query('COMMIT')

      const deletionResponse = await deletion

      expect(deletionResponse.status).toBe(204)

      const createResponse = await createGuestLoan(owner, {
        copyId: shelf.copyId,
        externalBorrowerId: contactId,
        handedAt: '2026-01-01',
      })

      expect(createResponse.status).toBe(404)
      expect(
        await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
      ).toBe(0)
    })

    it('create блокується на контакті, доки не звільниться; після — DELETE бачить щойно створену активну позику (409)', async () => {
      const owner = await registerAccount(app, 'race-create-del-2')
      const contactId = await createContact(owner, 'Гість Race Create2')
      const shelf = await createShelfCopy(app, owner)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "ExternalBorrower" WHERE "id" = $1 FOR UPDATE', [
        contactId,
      ])

      const creation = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactId,
          handedAt: '2026-01-01',
        }),
      )

      await waitForBlockedBackend(prisma, { expectedCount: 1 })
      await holder.query('COMMIT')

      const creationResponse = await creation

      expect(creationResponse.status).toBe(201)

      const deletionResponse = await deleteContact(owner, contactId)

      expect(deletionResponse.status).toBe(409)
      expect(errorCode(deletionResponse.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })
  })

  describe('Кілька Copy/Loan одного контакту в одному DELETE — детермінований порядок', () => {
    it('усі закриті позики різних Copy одного контакту: DELETE обнуляє всі відповідні рядки', async () => {
      const owner = await registerAccount(app, 'multi-copy')
      const contactId = await createContact(owner, 'Гість Multi')

      const shelfReturned = await createShelfCopy(app, owner)
      const returnedLoanId = await handedOverGuestLoan(owner, shelfReturned, contactId)

      await actOnGuestLoan(owner, returnedLoanId, { action: 'return' }).expect(200)

      const shelfRecovered = await createShelfCopy(app, owner)
      const recoveredLoanId = await lostGuestLoan(owner, shelfRecovered, contactId)

      await actOnGuestLoan(owner, recoveredLoanId, { action: 'recover' }).expect(200)

      const shelfClosed = await createShelfCopy(app, owner)
      const closedLoanId = await lostGuestLoan(owner, shelfClosed, contactId)

      await actOnGuestLoan(owner, closedLoanId, { action: 'close_loss' }).expect(200)

      // Лише closedLoanId лишає Copy.heldByContactId вказівним на контакт (close_loss його не
      // чіпає) — саме цей рядок і має обнулитися через FK при DELETE.
      const copyBefore = await prisma.copy.findUniqueOrThrow({ where: { id: shelfClosed.copyId } })

      expect(copyBefore.heldByContactId).toBe(contactId)

      const response = await deleteContact(owner, contactId)

      expect(response.status).toBe(204)

      for (const loanId of [returnedLoanId, recoveredLoanId, closedLoanId]) {
        const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

        expect(loan.borrowerContactId).toBeNull()
        expect(loan.borrowerKind).toBe('GUEST')
      }

      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: shelfClosed.copyId } }))
          .heldByContactId,
      ).toBeNull()
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })
  })

  /**
   * Item 6 (рев'ю): усі сценарії нижче доводять перекриття через РЕАЛЬНИЙ лок (сира сесія тримає
   * той самий ресурс, `waitForBlockedBackend` перевіряє генуїнну блокованість у
   * `pg_stat_activity`), а не лише `Promise.all` без доказу, що дві транзакції справді
   * перетнулися в часі. Для кожного сценарію також звіряємо фактичні події/стан у БД, а не лише
   * HTTP-статуси.
   */
  describe('Додаткові контрольовані гонки (item 6 рев’ю)', () => {
    it('два guest-create на один Copy — рівно один переможець, підтверджено блокуванням на Copy', async () => {
      const owner = await registerAccount(app, 'race-two-creates')
      const shelf = await createShelfCopy(app, owner)
      const contactA = await createContact(owner, 'Гість Two Creates A')
      const contactB = await createContact(owner, 'Гість Two Creates B')

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

      const raceA = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactA,
          handedAt: '2026-01-01',
        }),
      )
      const raceB = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactB,
          handedAt: '2026-01-01',
        }),
      )

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [a, b] = await Promise.all([raceA, raceB])
      const statuses = [a.status, b.status].sort()

      expect(statuses).toEqual([201, 409])
      // Рівно один рядок — переможець, а не два (жодного подвійного захоплення Copy).
      expect(
        await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
      ).toBe(1)
      expect(
        await prisma.loanEvent.count({
          where: { type: 'GUEST_LOAN_RECORDED', loan: { copyId: shelf.copyId } },
        }),
      ).toBe(1)
    })

    it('create ∥ registered approve — контрольовано (не лише Promise.all): переможець і стан узгоджені', async () => {
      const owner = await registerAccount(app, 'race-create-approve-controlled')
      const rival = await registerAccount(app, 'race-create-approve-controlled-r')

      await befriend(app, owner, rival)

      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Create Approve Controlled')
      const requested = await requestLoan(app, rival, shelf.copyId).expect(201)
      const rivalLoanId = (requested.body as { loan: { id: string } }).loan.id

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

      const create = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactId,
          handedAt: '2026-01-01',
        }),
      )
      const approve = beginRequest(actOnLoan(app, owner, rivalLoanId, { action: 'approve' }))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [createResult, approveResult] = await Promise.all([create, approve])
      const rivalLoan = await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })
      const guestCount = await prisma.loan.count({
        where: { copyId: shelf.copyId, borrowerKind: 'GUEST' },
      })

      if (createResult.status === 201) {
        expect(approveResult.status).toBe(409)
        expect(rivalLoan.status).toBe('REJECTED')
        expect(guestCount).toBe(1)
      } else {
        expect(createResult.status).toBe(409)
        expect(approveResult.status).toBe(200)
        expect(rivalLoan.status).toBe('APPROVED')
        expect(guestCount).toBe(0)
      }
    })

    it('create ∥ archive Copy — контрольовано: рівно один переможець', async () => {
      const owner = await registerAccount(app, 'race-create-archive')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Create Archive')

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query(
        'SELECT "archivedAt" FROM "Copy" WHERE "id" = $1 AND "ownerId" = $2 FOR UPDATE',
        [shelf.copyId, owner.id],
      )

      const create = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactId,
          handedAt: '2026-01-01',
        }),
      )
      const archive = beginRequest(archiveCopy(owner, shelf.copyId))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [createResult, archiveResult] = await Promise.all([create, archive])
      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      if (createResult.status === 201) {
        // Guest-create виграв першим: Copy тепер має ексклюзивну позику — archive відмовляє.
        expect(archiveResult.status).toBe(409)
        expect(copy.archivedAt).toBeNull()
        expect(copy.status).toBe('LENT_OUT')
      } else {
        // Archive виграв першим: Copy архівний — create бачить його недоступним.
        expect(archiveResult.status).toBe(200)
        expect(createResult.status).toBe(409)
        expect(copy.archivedAt).not.toBeNull()
        expect(
          await prisma.loan.count({ where: { copyId: shelf.copyId, borrowerKind: 'GUEST' } }),
        ).toBe(0)
      }
    })

    it('create ∥ DELETE Copy (без loan-історії) — контрольовано: рівно один переможець', async () => {
      const owner = await registerAccount(app, 'race-create-delete-copy')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Create Delete Copy')

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

      const create = beginRequest(
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactId,
          handedAt: '2026-01-01',
        }),
      )
      const remove = beginRequest(deleteCopy(owner, shelf.copyId))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [createResult, removeResult] = await Promise.all([create, remove])

      if (createResult.status === 201) {
        // Guest-create виграв: Copy тепер має Loan, DELETE (FK RESTRICT) відмовляє.
        expect(removeResult.status).toBe(409)
        expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(1)
      } else {
        // DELETE виграв: Copy зник до того, як create встиг його побачити.
        expect(removeResult.status).toBe(204)
        expect(createResult.status).toBe(404)
        expect(await prisma.copy.count({ where: { id: shelf.copyId } })).toBe(0)
      }
    })

    it('return ∥ mark_lost — контрольовано: рівно один переможець, рівно одна відповідна подія', async () => {
      const owner = await registerAccount(app, 'race-return-lost')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Return Lost')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query(
        `SELECT c."id" FROM "Loan" l JOIN "Copy" c ON c."id" = l."copyId" WHERE l."id" = $1 FOR UPDATE OF c`,
        [loanId],
      )

      const returnRace = beginRequest(actOnGuestLoan(owner, loanId, { action: 'return' }))
      const markLostRace = beginRequest(actOnGuestLoan(owner, loanId, { action: 'mark_lost' }))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [returnResult, markLostResult] = await Promise.all([returnRace, markLostRace])
      const statuses = [returnResult.status, markLostResult.status].sort()

      expect(statuses).toEqual([200, 409])

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const events = await prisma.loanEvent.findMany({ where: { loanId } })
      const returnedEvents = events.filter((event) => event.type === 'LOAN_RETURNED')
      const lostEvents = events.filter((event) => event.type === 'LOAN_LOST')

      if (returnResult.status === 200) {
        expect(loan.status).toBe('RETURNED')
        expect(returnedEvents).toHaveLength(1)
        expect(lostEvents).toHaveLength(0)
      } else {
        expect(loan.status).toBe('LOST')
        expect(lostEvents).toHaveLength(1)
        expect(returnedEvents).toHaveLength(0)
      }
    })

    it('recover ∥ recover — рівно один 200, рівно одна RECOVERED', async () => {
      const owner = await registerAccount(app, 'race-recover-recover')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Recover Recover')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query(
        `SELECT c."id" FROM "Loan" l JOIN "Copy" c ON c."id" = l."copyId" WHERE l."id" = $1 FOR UPDATE OF c`,
        [loanId],
      )

      const raceA = beginRequest(actOnGuestLoan(owner, loanId, { action: 'recover' }))
      const raceB = beginRequest(actOnGuestLoan(owner, loanId, { action: 'recover' }))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [a, b] = await Promise.all([raceA, raceB])
      const statuses = [a.status, b.status].sort()

      expect(statuses).toEqual([200, 409])
      expect(errorCode((a.status === 409 ? a : b).body)).toBe('LOAN_ALREADY_RECOVERED')
      expect(await prisma.loanEvent.count({ where: { loanId, type: 'RECOVERED' } })).toBe(1)

      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })

      expect(copy.status).toBe('AVAILABLE')
      expect(copy.currentHolderId).toBe(owner.id)
    })

    it('close_loss ∥ close_loss — рівно один 200, рівно одна LOSS_CLOSED', async () => {
      const owner = await registerAccount(app, 'race-close-close')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість Close Close')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const holder = await session()

      await holder.query('BEGIN')
      await holder.query(
        `SELECT c."id" FROM "Loan" l JOIN "Copy" c ON c."id" = l."copyId" WHERE l."id" = $1 FOR UPDATE OF c`,
        [loanId],
      )

      const raceA = beginRequest(actOnGuestLoan(owner, loanId, { action: 'close_loss' }))
      const raceB = beginRequest(actOnGuestLoan(owner, loanId, { action: 'close_loss' }))

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const [a, b] = await Promise.all([raceA, raceB])
      const statuses = [a.status, b.status].sort()

      expect(statuses).toEqual([200, 409])
      expect(errorCode((a.status === 409 ? a : b).body)).toBe('LOAN_ALREADY_CLOSED')
      expect(await prisma.loanEvent.count({ where: { loanId, type: 'LOSS_CLOSED' } })).toBe(1)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.status).toBe('LOST')
    })
  })
})
