import 'reflect-metadata'
import { Client } from 'pg'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  loanResponseSchema,
  type ApiErrorCode,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { beginRequest, waitForBlockedBackend } from './concurrency.helpers'
import { testDatabaseUrl } from './db/test-database'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
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
 * Stage 10, крок 10d (docs/plan/stage-10-real-world-history.md, §6.2, §6.6, §6.8, REC1–REC5, A4):
 * `PATCH /loans/:id { action: 'recover', effectiveAt? }` і `LoanEvent`.
 */
describe('Stage 10 (10d): recover втраченого примірника (e2e)', () => {
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

  interface Setup {
    owner: Account
    borrower: Account
    shelf: Shelf
    loanId: string
  }

  const http = () => app.getHttpServer()

  /** Власник + друг-позичальник + примірник, доведений до LOST через справжній API. */
  async function lostLoan(): Promise<Setup> {
    const owner = await registerAccount(app, 'rec-owner')
    const borrower = await registerAccount(app, 'rec-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

    await actOnLoan(app, owner, loanId, { action: 'mark_lost' }).expect(200)

    return { owner, borrower, shelf, loanId }
  }

  const recover = (actor: Account, loanId: string, body: Record<string, unknown> = {}) =>
    actOnLoan(app, actor, loanId, { action: 'recover', ...body })

  const archive = (account: Account, copyId: string): request.Test =>
    request(http())
      .post(url(`/me/library/${copyId}/archive`))
      .set('Cookie', account.cookie)

  const restore = (account: Account, copyId: string): request.Test =>
    request(http())
      .post(url(`/me/library/${copyId}/restore`))
      .set('Cookie', account.cookie)

  const errorCode = (body: unknown): ApiErrorCode => apiErrorSchema.parse(body).code

  const events = (loanId: string) =>
    prisma.loanEvent.findMany({ where: { loanId }, orderBy: { occurredAt: 'asc' } })

  const copyRow = (copyId: string) => prisma.copy.findUniqueOrThrow({ where: { id: copyId } })
  const loanRow = (loanId: string) => prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

  const utcDay = (offsetDays = 0): string =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

  async function session(): Promise<Client> {
    const client = new Client({ connectionString: testDatabaseUrl() })

    await client.connect()
    sessions.push(client)

    return client
  }

  describe('LOAN_LOST при mark_lost (T4, §6.8)', () => {
    it('новий mark_lost пише рівно одну LOAN_LOST у тій самій транзакції; порожній payload', async () => {
      const { owner, loanId } = await lostLoan()

      const stored = await events(loanId)

      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({
        type: 'LOAN_LOST',
        actorId: owner.id,
        effectiveAt: null,
        payload: {},
      })
    })

    it('звичайні request-flow позики подій заднім числом не отримують', async () => {
      const owner = await registerAccount(app, 'rec-noevt-o')
      const borrower = await registerAccount(app, 'rec-noevt-b')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      expect(await events(loanId)).toEqual([])
    })
  })

  describe('REC1: recover змінює лише потрібний стан', () => {
    it('Copy → AVAILABLE, тримач — власник; Loan лишається LOST і не змінюється; RECOVERED з effectiveAt', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const copyBefore = await copyRow(shelf.copyId)
      const loanBefore = await loanRow(loanId)

      expect(copyBefore.status).toBe('UNAVAILABLE')
      expect(copyBefore.currentHolderId).not.toBe(owner.id)

      const day = utcDay(-3)
      const response = await recover(owner, loanId, { effectiveAt: day }).expect(200)
      const { loan } = loanResponseSchema.parse(response.body)

      expect(loan.status).toBe('LOST')
      expect(loan.copy.status).toBe('AVAILABLE')
      expect(loan.recovery?.effectiveAt).toBe(`${day}T00:00:00.000Z`)

      const copyAfter = await copyRow(shelf.copyId)

      expect(copyAfter).toEqual({
        ...copyBefore,
        status: 'AVAILABLE',
        currentHolderId: owner.id,
        heldByContactId: null,
      })
      // Жодного минулого факту позики не змінено — рядок Loan байт-в-байт той самий.
      expect(await loanRow(loanId)).toEqual(loanBefore)

      const recovered = (await events(loanId)).filter((event) => event.type === 'RECOVERED')

      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({
        actorId: owner.id,
        effectiveAt: new Date(`${day}T00:00:00.000Z`),
        payload: {},
      })
    })

    it('без effectiveAt береться поточна серверна дата', async () => {
      const { owner, loanId } = await lostLoan()
      const before = Date.now()

      await recover(owner, loanId).expect(200)

      const [event] = (await events(loanId)).filter((item) => item.type === 'RECOVERED')
      const effective = event?.effectiveAt?.getTime() ?? 0

      expect(effective).toBeGreaterThanOrEqual(before - 1000)
      expect(effective).toBeLessThanOrEqual(Date.now() + 1000)
    })

    it('дата «сьогодні» (UTC) приймається', async () => {
      const { owner, loanId } = await lostLoan()

      await recover(owner, loanId, { effectiveAt: utcDay() }).expect(200)
    })

    it('GET /loans/:id віддає факт знахідки обом сторонам, статус лишається LOST', async () => {
      const { owner, borrower, loanId } = await lostLoan()

      await recover(owner, loanId, { effectiveAt: utcDay(-1) }).expect(200)

      for (const account of [owner, borrower]) {
        const response = await request(http())
          .get(url(`/loans/${loanId}`))
          .set('Cookie', account.cookie)
          .expect(200)
        const { loan } = loanResponseSchema.parse(response.body)

        expect(loan.status).toBe('LOST')
        expect(loan.recovery?.effectiveAt).toBe(`${utcDay(-1)}T00:00:00.000Z`)
      }
    })
  })

  describe('REC2: однократність ефекту', () => {
    it('другий послідовний recover — 409 LOAN_ALREADY_RECOVERED, одна подія, стан не змінився', async () => {
      const { owner, shelf, loanId } = await lostLoan()

      await recover(owner, loanId).expect(200)

      const copyAfterFirst = await copyRow(shelf.copyId)
      const second = await recover(owner, loanId, { effectiveAt: utcDay(-5) }).expect(409)

      expect(errorCode(second.body)).toBe(API_ERROR_CODES.LOAN_ALREADY_RECOVERED)
      expect((await events(loanId)).filter((event) => event.type === 'RECOVERED')).toHaveLength(1)
      expect(await copyRow(shelf.copyId)).toEqual(copyAfterFirst)
    })

    it('після recover книжку віддали далі: повторний recover старої позики не перезаписує стан примірника', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const next = await registerAccount(app, 'rec-next')

      await befriend(app, owner, next)
      await recover(owner, loanId).expect(200)

      const nextLoan = await handedOverLoan(app, owner, next, shelf.copyId)
      const lent = await copyRow(shelf.copyId)

      expect(lent.status).toBe('LENT_OUT')

      const again = await recover(owner, loanId).expect(409)

      expect(errorCode(again.body)).toBe(API_ERROR_CODES.LOAN_ALREADY_RECOVERED)
      expect(await copyRow(shelf.copyId)).toEqual(lent)
      expect((await loanRow(nextLoan)).status).toBe('HANDED_OVER')
    })

    it('конкурентні recover: один 200, один 409, одна подія, один перехід стану', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const holder = await session()

      // Лок на Copy — той самий рядок, що захоплює LoanService: обидва запити стають у чергу.
      await holder.query('BEGIN')
      await holder.query('SELECT "id" FROM "Copy" WHERE "id" = $1 FOR UPDATE', [shelf.copyId])

      const race = Promise.all([
        beginRequest(recover(owner, loanId)),
        beginRequest(recover(owner, loanId)),
      ])

      await waitForBlockedBackend(prisma, { expectedCount: 2 })
      await holder.query('COMMIT')

      const responses = await race
      const statuses = responses.map((response) => response.status).sort()

      expect(statuses).toEqual([200, 409])

      const loser = responses.find((response) => response.status === 409)

      expect(errorCode(loser?.body)).toBe(API_ERROR_CODES.LOAN_ALREADY_RECOVERED)
      expect((await events(loanId)).filter((event) => event.type === 'RECOVERED')).toHaveLength(1)
      expect((await copyRow(shelf.copyId)).status).toBe('AVAILABLE')
    })

    it('порушення унікального індексу під час INSERT події: 409 замість 500, і стан Copy відкочено', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const copyBefore = await copyRow(shelf.copyId)
      const rival = await session()

      // Незакомічена конкурентна RECOVERED: перевірка під локом її не бачить, тож запит доходить до
      // INSERT і впирається в `one_recovery_per_loan` — рівно той шлях, який має мапитися в 409.
      await rival.query('BEGIN')
      await rival.query(
        `INSERT INTO "LoanEvent" (id, "loanId", type) VALUES ('rival-ev', $1, 'RECOVERED')`,
        [loanId],
      )

      const pending = beginRequest(recover(owner, loanId))

      await waitForBlockedBackend(prisma, { expectedCount: 1 })
      await rival.query('COMMIT')

      const response = await pending

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_ALREADY_RECOVERED)
      // Зміна примірника, зроблена до INSERT події, відкотилася разом із транзакцією.
      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect((await events(loanId)).filter((event) => event.type === 'RECOVERED')).toHaveLength(1)
    })
  })

  describe('REC3: відмови', () => {
    it('позичальник — 403, стороння людина — 404; нічого не змінюється', async () => {
      const { borrower, shelf, loanId } = await lostLoan()
      const stranger = await registerAccount(app, 'rec-stranger')
      const copyBefore = await copyRow(shelf.copyId)

      const asBorrower = await recover(borrower, loanId).expect(403)

      expect(errorCode(asBorrower.body)).toBe(API_ERROR_CODES.FORBIDDEN)
      await recover(stranger, loanId).expect(404)

      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect((await events(loanId)).map((event) => event.type)).toEqual(['LOAN_LOST'])
    })

    it.each(['approved', 'handed_over', 'returned', 'requested'] as const)(
      'позика не LOST (%s) — 409 LOAN_INVALID_TRANSITION',
      async (stage) => {
        const owner = await registerAccount(app, 'rec-st-o')
        const borrower = await registerAccount(app, 'rec-st-b')

        await befriend(app, owner, borrower)

        const shelf = await createShelfCopy(app, owner)
        const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
        const loanId = loanResponseSchema.parse(created.body).loan.id

        if (stage !== 'requested') await actOnLoan(app, owner, loanId, { action: 'approve' })
        if (stage === 'handed_over' || stage === 'returned') {
          await actOnLoan(app, borrower, loanId, { action: 'hand_over' })
        }
        if (stage === 'returned') await actOnLoan(app, owner, loanId, { action: 'return' })

        const copyBefore = await copyRow(shelf.copyId)
        const response = await recover(owner, loanId).expect(409)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_INVALID_TRANSITION)
        expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
        expect(await events(loanId)).toEqual([])
      },
    )

    it('дата в майбутньому — 400 LOAN_RECOVERY_DATE_INVALID; стан і події не змінено', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const copyBefore = await copyRow(shelf.copyId)

      for (const day of [utcDay(1), '2999-01-01']) {
        const response = await recover(owner, loanId, { effectiveAt: day }).expect(400)

        expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_RECOVERY_DATE_INVALID)
      }

      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect((await events(loanId)).map((event) => event.type)).toEqual(['LOAN_LOST'])
    })

    it.each([
      ['дата з часом', { effectiveAt: '2026-09-20T10:00:00Z' }],
      ['неіснуюча дата', { effectiveAt: '2026-02-30' }],
      ['не рядок', { effectiveAt: 20260920 }],
      ['note з recover', { note: 'знайшли' }],
      ['зайве поле', { reason: 'x' }],
    ])('невалідне тіло (%s) — 400 VALIDATION_ERROR', async (_name, body) => {
      const { owner, loanId } = await lostLoan()
      const response = await recover(owner, loanId, body).expect(400)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect((await events(loanId)).map((event) => event.type)).toEqual(['LOAN_LOST'])
    })

    it('effectiveAt разом з іншою дією — 400', async () => {
      const { owner, loanId } = await lostLoan()

      const response = await actOnLoan(app, owner, loanId, {
        action: 'return',
        effectiveAt: utcDay(-1),
      }).expect(400)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('Copy не в очікуваному стані (не UNAVAILABLE у позичальника) — 409 LOAN_COPY_STATE_MISMATCH', async () => {
      const { owner, shelf, loanId } = await lostLoan()

      await prisma.copy.update({
        where: { id: shelf.copyId },
        data: { status: 'AVAILABLE', currentHolderId: owner.id },
      })

      const copyBefore = await copyRow(shelf.copyId)
      const response = await recover(owner, loanId).expect(409)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH)
      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect((await events(loanId)).map((event) => event.type)).toEqual(['LOAN_LOST'])
    })

    it('Copy зайнятий іншою ексклюзивною позикою — recover не перезаписує її стан', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const other = await registerAccount(app, 'rec-occ')

      await befriend(app, owner, other)

      const occupying = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: other.id,
          status: 'APPROVED',
        },
      })
      const copyBefore = await copyRow(shelf.copyId)
      const response = await recover(owner, loanId).expect(409)

      expect(errorCode(response.body)).toBe(API_ERROR_CODES.LOAN_COPY_STATE_MISMATCH)
      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect((await loanRow(occupying.id)).status).toBe('APPROVED')
    })
  })

  describe('A4: архівний примірник', () => {
    it('recover на архівному — 409 COPY_ARCHIVED; restore → recover працює', async () => {
      const { owner, shelf, loanId } = await lostLoan()

      // LOST-примірник архівувати дозволено (§6.5).
      await archive(owner, shelf.copyId).expect(200)

      const archived = await copyRow(shelf.copyId)
      const refused = await recover(owner, loanId).expect(409)

      expect(errorCode(refused.body)).toBe(API_ERROR_CODES.COPY_ARCHIVED)
      expect(await copyRow(shelf.copyId)).toEqual(archived)
      expect((await events(loanId)).map((event) => event.type)).toEqual(['LOAN_LOST'])

      const loanView = await request(http())
        .get(url(`/loans/${loanId}`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(loanResponseSchema.parse(loanView.body).loan.copy.isArchived).toBe(true)

      await restore(owner, shelf.copyId).expect(200)
      await recover(owner, loanId).expect(200)

      const after = await copyRow(shelf.copyId)

      expect(after).toMatchObject({
        status: 'AVAILABLE',
        currentHolderId: owner.id,
        archivedAt: null,
      })
    })
  })

  describe('REC4: після recover книжка знову доступна, минуле збережене', () => {
    it('новий запит проходить; стара LOST-позика і її історія лишаються', async () => {
      const { owner, shelf, loanId } = await lostLoan()
      const next = await registerAccount(app, 'rec-again')

      await befriend(app, owner, next)

      const blocked = await requestLoan(app, next, shelf.copyId).expect(409)

      expect(errorCode(blocked.body)).toBe(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)

      await recover(owner, loanId).expect(200)
      await requestLoan(app, next, shelf.copyId).expect(201)

      const list = await request(http())
        .get(url('/loans?role=owner'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const old = (
        list.body as { loans: { id: string; status: string; recovery: unknown }[] }
      ).loans.find((loan) => loan.id === loanId)

      expect(old).toMatchObject({ status: 'LOST' })
      expect(old?.recovery).not.toBeNull()

      const history = await request(http())
        .get(url(`/copies/${shelf.copyId}/history`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(
        (history.body as { entries: { status: string }[] }).entries.map((entry) => entry.status),
      ).toContain('LOST')
    })
  })

  describe('REC5: стара LOST-позика без подій', () => {
    it('відновлюється; минула дата втрати не вигадується', async () => {
      const { owner, shelf, loanId } = await lostLoan()

      // Імітація позики, втраченої до кроку 10d: LOAN_LOST для неї ніколи не існував.
      await prisma.loanEvent.deleteMany({ where: { loanId } })

      const response = await recover(owner, loanId).expect(200)

      expect(loanResponseSchema.parse(response.body).loan.status).toBe('LOST')
      expect((await copyRow(shelf.copyId)).status).toBe('AVAILABLE')
      expect((await events(loanId)).map((event) => event.type)).toEqual(['RECOVERED'])
    })
  })

  describe('приватність LoanEvent', () => {
    it('друг власника і стороння людина не бачать знахідки: ні /loans, ні історія', async () => {
      const { owner, borrower, shelf, loanId } = await lostLoan()
      const friend = await registerAccount(app, 'rec-friend')
      const stranger = await registerAccount(app, 'rec-stranger2')

      await befriend(app, owner, friend)
      await recover(owner, loanId, { effectiveAt: utcDay(-2) }).expect(200)

      for (const account of [friend, stranger]) {
        await request(http())
          .get(url(`/loans/${loanId}`))
          .set('Cookie', account.cookie)
          .expect(404)
      }

      for (const path of [`/copies/${shelf.copyId}/history`, `/works/${shelf.workId}/history`]) {
        for (const account of [friend, borrower]) {
          const response = await request(http()).get(url(path)).set('Cookie', account.cookie)
          const text = JSON.stringify(response.body)

          expect(text).not.toMatch(/recover|RECOVERED|effectiveAt|LOAN_LOST|LoanEvent/i)
        }
      }
    })
  })

  describe('межа request-flow: recover не відкриває записані позики (10a → 10e/10f)', () => {
    it.each([
      ['RECORDED_EXISTING', 'REGISTERED'],
      ['RECORDED_GUEST', 'GUEST'],
    ] as const)('origin %s (%s): 404, нічого не змінено', async (origin, borrowerKind) => {
      const owner = await registerAccount(app, 'rec-bd-o')
      const borrower = await registerAccount(app, 'rec-bd-b')

      await befriend(app, owner, borrower)

      const shelf = await createShelfCopy(app, owner)
      const guest = borrowerKind === 'GUEST'

      await prisma.copy.update({
        where: { id: shelf.copyId },
        data: { status: 'UNAVAILABLE', currentHolderId: guest ? null : borrower.id },
      })

      const foreign = await prisma.loan.create({
        data: {
          copyId: shelf.copyId,
          ownerId: owner.id,
          borrowerId: guest ? null : borrower.id,
          borrowerKind,
          origin,
          status: 'LOST',
          handedAt: new Date('2026-08-01T00:00:00Z'),
        },
      })
      const copyBefore = await copyRow(shelf.copyId)

      await recover(owner, foreign.id).expect(404)
      await recover(borrower, foreign.id).expect(404)

      expect(await copyRow(shelf.copyId)).toEqual(copyBefore)
      expect(await events(foreign.id)).toEqual([])
      expect((await loanRow(foreign.id)).status).toBe('LOST')
    })
  })
})
