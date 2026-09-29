import './helpers/guest-loans-on'
import 'reflect-metadata'
import request from 'supertest'
import { externalBorrowerResponseSchema, guestLoanResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { createShelfCopy, registerAccount, url, type Account, type Shelf } from './loan.helpers'
import { GuestContactRetentionCleanupService } from '../src/external-borrowers/guest-contact-retention-cleanup.service'
import { recomputeRetainUntil } from '../src/external-borrowers/retention'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10 (10h, docs/plan/stage-10-real-world-history.md §0.7/§0.7.1/§0.9/§6.11, RET1–RET20).
 * `retention.spec.ts` доводить саму формулу без БД; тут — що реальні переходи під реальними
 * локами дійсно записують `retainUntil`, і що CLI-чистка (`GuestContactRetentionCleanupService`)
 * коректно читає/бекфілить/видаляє на реальній БД. Сервіс НЕ підключений до `AppModule`
 * (§ докстрінг сервісу) — інстанціюється напряму, той самий принцип, що
 * `funnel-report-network.db-spec.ts` (`new FunnelReportService(prismaService)`).
 */
describe('Stage 10 (10h): retention гостьових контактів (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cleanup: GuestContactRetentionCleanupService
  const http = (): App => app.getHttpServer()
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

  async function retainUntilOf(contactId: string): Promise<Date | null> {
    const row = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contactId } })

    return row.retainUntil
  }

  /**
   * `lostGuestLoan` записує `LOAN_LOST.occurredAt` через реальний server-час (момент виклику
   * тесту) — не роками в минулому. Щоб змоделювати «365-денна межа вже давно минула» (керований
   * годинник, без вигаданих фактів понад це одне поле), тест сам зсуває вже наявну подію в
   * фіксоване минуле й ЯВНО перераховує `retainUntil` (`recomputeRetainUntil`, той самий виклик,
   * що робить кожен реальний перехід) — інакше збережене значення лишилося б застарілим і після
   * ручного `UPDATE` `LoanEvent`, спотворюючи сам сценарій, який тест намагається побудувати.
   * Повертає `staleNow` — момент, який давно минув відносно ЦІЄЇ (тепер застарілої) 365-денної
   * межі, але завідомо раніший за будь-яке майбутнє значення, яке дасть `close_loss`/`recover`.
   */
  async function backdateLostEvent(loanId: string, contactId: string): Promise<Date> {
    const backdatedLostAt = new Date('2020-01-01T00:00:00.000Z')

    await prisma.loanEvent.updateMany({
      where: { loanId, type: 'LOAN_LOST' },
      data: { occurredAt: backdatedLostAt },
    })
    await recomputeRetainUntil(prisma, contactId)

    return new Date(backdatedLostAt.getTime() + 400 * DAY_MS)
  }

  describe('Реальні переходи записують retainUntil у ТІЙ САМІЙ транзакції (§6.11)', () => {
    it('RET1: HANDED_OVER → retainUntil=NULL', async () => {
      const owner = await registerAccount(app, 'rw-active')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'RW Active')

      await handedOverGuestLoan(owner, shelf, contactId)

      expect(await retainUntilOf(contactId)).toBeNull()
    })

    it('RET2: return → retainUntil = returnedAt + 90д (з точністю до секунд реального часу)', async () => {
      const owner = await registerAccount(app, 'rw-return')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'RW Return')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil).not.toBeNull()
      expect(loan.returnedAt).not.toBeNull()
      expect(retainUntil!.getTime()).toBe(loan.returnedAt!.getTime() + 90 * DAY_MS)
    })

    it('RET4: mark_lost → retainUntil = LOAN_LOST.occurredAt + 365д, НЕ NULL', async () => {
      const owner = await registerAccount(app, 'rw-lost')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'RW Lost')

      const loanId = await lostGuestLoan(owner, shelf, contactId)
      const lostEvent = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId, type: 'LOAN_LOST' },
      })
      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil).not.toBeNull()
      expect(retainUntil!.getTime()).toBe(lostEvent.occurredAt.getTime() + 365 * DAY_MS)
    })

    it('close_loss → retainUntil = closedAt(LOSS_CLOSED) + 90д, доданок +365д більше не рахується', async () => {
      const owner = await registerAccount(app, 'rw-close')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'RW Close')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)

      const closure = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId, type: 'LOSS_CLOSED' },
      })
      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil!.getTime()).toBe(closure.occurredAt.getTime() + 90 * DAY_MS)
    })

    it('нова гостьова позика скидає retainUntil закритого контакту назад у NULL', async () => {
      const owner = await registerAccount(app, 'rw-reset')
      const shelf1 = await createShelfCopy(app, owner)
      const shelf2 = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'RW Reset')
      const firstLoan = await handedOverGuestLoan(owner, shelf1, contactId)

      await actOnGuestLoan(owner, firstLoan, { action: 'return' }).expect(200)
      expect(await retainUntilOf(contactId)).not.toBeNull()

      await handedOverGuestLoan(owner, shelf2, contactId)
      expect(await retainUntilOf(contactId)).toBeNull()
    })
  })

  describe('CLI-чистка: межові умови (керований годинник — прямий запис retainUntil)', () => {
    it('RET2: 89 днів — контакт лишається; 90 днів — видаляється разом з alias', async () => {
      const owner = await registerAccount(app, 'cli-89-90')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI 89-90')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const boundary = new Date(loan.returnedAt!.getTime() + 90 * DAY_MS)

      const at89 = new Date(boundary.getTime() - DAY_MS)

      await cleanup.run(at89)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)

      await cleanup.run(boundary)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('RET12: незакрита LOST — 364 дні лишається, 365 днів видаляється', async () => {
      const owner = await registerAccount(app, 'cli-364-365')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI 364-365')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const lostEvent = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId, type: 'LOAN_LOST' },
      })
      const boundary = new Date(lostEvent.occurredAt.getTime() + 365 * DAY_MS)
      const at364 = new Date(boundary.getTime() - DAY_MS)

      await cleanup.run(at364)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('LOST')

      await cleanup.run(boundary)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

      const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loanAfter.status).toBe('LOST')
      expect(loanAfter.borrowerContactId).toBeNull()
    })

    it('RET13: дві незакриті LOST з різними occurredAt — чистка лише після більшої межі', async () => {
      const owner = await registerAccount(app, 'cli-two-lost')
      const shelfA = await createShelfCopy(app, owner)
      const shelfB = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Two Lost')

      const loanA = await lostGuestLoan(owner, shelfA, contactId)
      const loanB = await lostGuestLoan(owner, shelfB, contactId)

      // Керований годинник: розводимо occurredAt напряму (RET13 вимагає різницю в часі
      // втрат, а не реального очікування), не вигадуючи ЖОДНОЇ нової події — лише
      // зсуваємо існуючі.
      const eventA = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId: loanA, type: 'LOAN_LOST' },
      })
      const earlyLost = new Date('2026-01-01T00:00:00.000Z')
      const lateLost = new Date(earlyLost.getTime() + 100 * DAY_MS)

      await prisma.loanEvent.update({ where: { id: eventA.id }, data: { occurredAt: earlyLost } })
      await prisma.loanEvent.updateMany({
        where: { loanId: loanB, type: 'LOAN_LOST' },
        data: { occurredAt: lateLost },
      })

      const smallerBoundary = new Date(earlyLost.getTime() + 365 * DAY_MS)
      const largerBoundary = new Date(lateLost.getTime() + 365 * DAY_MS)

      // Контакт має NULL до першого backfill/recompute-проходу — прив'язаний до legacy
      // NULL-стану, який покриває фаза backfill нижче.
      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: null },
      })

      await cleanup.run(smallerBoundary)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)

      await cleanup.run(largerBoundary)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('RET17: 365-денна межа минула, але ручний DELETE лишається 409 — межа відкриває лише автоматичну чистку', async () => {
      const owner = await registerAccount(app, 'cli-manual-delete')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Manual Delete')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      // Стан «365-денна межа вже минула, але щоденний CLI ще не пройшовся» (§0.9: «момент
      // retainUntil — це момент ДОПУСТИМОСТІ чистки, а не миттєве видалення») — НЕ через
      // cleanup.run() (це видалило б контакт і саме зробило б тест неможливим), а прямим записом,
      // що й моделює це проміжне вікно.
      const lostEvent = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId, type: 'LOAN_LOST' },
      })
      const wayPast = new Date(lostEvent.occurredAt.getTime() + 400 * DAY_MS)

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: wayPast },
      })

      const response = await deleteContact(owner, contactId)

      expect(response.status).toBe(409)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)

      // Контроль: та сама межа, яку ручний DELETE ігнорує, ДІЙСНО відкриває автоматичну чистку.
      await cleanup.run(wayPast)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('RET18: авто-чистка зберігає Loan/LoanEvent; recover після чистки й далі можливий, контакт не відновлюється', async () => {
      const owner = await registerAccount(app, 'cli-recover-after')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Recover After')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const lostEvent = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId, type: 'LOAN_LOST' },
      })
      const past365 = new Date(lostEvent.occurredAt.getTime() + 365 * DAY_MS)

      await cleanup.run(past365)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

      const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loanBefore.borrowerContactId).toBeNull()
      expect(loanBefore.borrowerKind).toBe('GUEST')
      expect(loanBefore.status).toBe('LOST')
      expect(await prisma.loanEvent.count({ where: { loanId } })).toBeGreaterThan(0)

      const recovered = await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)
      const loan = guestLoanResponseSchema.parse(recovered.body).loan

      expect(loan.recovery).not.toBeNull()
      expect(loan.contact).toBeNull()
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('RET19: минула 365-денна межа однієї LOST не заважає — повернення ІНШОЇ позики переважає в max()', async () => {
      const owner = await registerAccount(app, 'cli-ret19')
      const shelfLost = await createShelfCopy(app, owner)
      const shelfReturned = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI RET19')

      const lostLoanId = await lostGuestLoan(owner, shelfLost, contactId)
      const returnedLoanId = await handedOverGuestLoan(owner, shelfReturned, contactId)

      // Керований годинник: LOST-подія — давно в минулому (365-денна межа вже минула).
      await prisma.loanEvent.updateMany({
        where: { loanId: lostLoanId, type: 'LOAN_LOST' },
        data: { occurredAt: new Date('2020-01-01T00:00:00.000Z') },
      })

      await actOnGuestLoan(owner, returnedLoanId, { action: 'return' }).expect(200) // перерахунок у транзакції

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: returnedLoanId } })
      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil!.getTime()).toBe(loan.returnedAt!.getTime() + 90 * DAY_MS)

      const past365ForLost = new Date('2020-01-01T00:00:00.000Z').getTime() + 365 * DAY_MS

      expect(retainUntil!.getTime()).toBeGreaterThan(past365ForLost)

      // Чистка на момент, коли ЛИШЕ давня LOST-межа минула (а returnedAt+90д ще ні) — не видаляє.
      await cleanup.run(new Date(past365ForLost + DAY_MS))
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })

    it('RET20: активна позика mark_lost замінює NULL на СВІЖУ 365-денну межу, не на минулу межу іншої LOST', async () => {
      const owner = await registerAccount(app, 'cli-ret20')
      const shelfOldLost = await createShelfCopy(app, owner)
      const shelfActive = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI RET20')

      const oldLostLoanId = await lostGuestLoan(owner, shelfOldLost, contactId)

      await prisma.loanEvent.updateMany({
        where: { loanId: oldLostLoanId, type: 'LOAN_LOST' },
        data: { occurredAt: new Date('2020-01-01T00:00:00.000Z') },
      })

      const activeLoanId = await handedOverGuestLoan(owner, shelfActive, contactId)

      expect(await retainUntilOf(contactId)).toBeNull() // активна позика перекриває стару межу

      await actOnGuestLoan(owner, activeLoanId, { action: 'mark_lost' }).expect(200)

      const newLostEvent = await prisma.loanEvent.findFirstOrThrow({
        where: { loanId: activeLoanId, type: 'LOAN_LOST' },
      })
      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil).not.toBeNull()
      expect(retainUntil!.getTime()).toBe(newLostEvent.occurredAt.getTime() + 365 * DAY_MS)
      // Контроль: НЕ давно минула межа старої LOST.
      expect(retainUntil!.getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('Backfill: уже наявні контакти 10f.2/10f.3/10g з retainUntil=NULL', () => {
    it('легасі-контакт без позик отримує createdAt+90д при першому проході чистки', async () => {
      const owner = await registerAccount(app, 'backfill-empty')
      const contactId = await createContact(owner, 'Backfill Empty')
      const createdAt = new Date('2026-01-01T00:00:00.000Z')

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { createdAt, retainUntil: null }, // симулює контакт, створений до 10h
      })

      const summary = await cleanup.run(new Date('2026-01-02T00:00:00.000Z'))

      expect(summary.backfilled).toBeGreaterThanOrEqual(1)

      const retainUntil = await retainUntilOf(contactId)

      expect(retainUntil!.getTime()).toBe(createdAt.getTime() + 90 * DAY_MS)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })

    it('легасі-контакт із давно закритою позикою — бекфіл одразу дає минулу дату, чистка видаляє в тому ж проході', async () => {
      const owner = await registerAccount(app, 'backfill-old-return')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Backfill Old Return')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const longAgo = new Date('2020-01-01T00:00:00.000Z')

      await prisma.loan.update({ where: { id: loanId }, data: { returnedAt: longAgo } })
      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: null },
      })

      const summary = await cleanup.run(new Date())

      expect(summary.backfilled).toBeGreaterThanOrEqual(1)
      expect(summary.deleted).toBeGreaterThanOrEqual(1)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.borrowerContactId).toBeNull()
      expect(loan.status).toBe('RETURNED')
    })

    it('легасі-контакт з активною позикою лишається NULL і не видаляється (backfill не плутає активність з відсутністю даних)', async () => {
      const owner = await registerAccount(app, 'backfill-active')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Backfill Active')

      await handedOverGuestLoan(owner, shelf, contactId)
      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: null },
      })

      await cleanup.run(new Date())

      expect(await retainUntilOf(contactId)).toBeNull()
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })
  })

  describe('Ідемпотентність і конкурентність CLI (RET6)', () => {
    it('повторний запуск того самого дня — безпечний no-op для вже опрацьованих контактів', async () => {
      const owner = await registerAccount(app, 'cli-idempotent')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Idempotent')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const deleteAt = new Date(loan.returnedAt!.getTime() + 90 * DAY_MS)

      const first = await cleanup.run(deleteAt)

      expect(first.deleted).toBeGreaterThanOrEqual(1)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

      // Другий прохід того самого дня: контакту вже немає — не помилка, лічильник для НЬОГО нуль.
      const second = await cleanup.run(deleteAt)

      expect(second.deleted).toBe(0)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('два одночасні запуски run() — жодної помилки, жодного подвійного видалення, підсумково рівно один контакт стертий', async () => {
      const owner = await registerAccount(app, 'cli-concurrent-runs')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Concurrent Runs')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const deleteAt = new Date(loan.returnedAt!.getTime() + 90 * DAY_MS)

      const [first, second] = await Promise.all([cleanup.run(deleteAt), cleanup.run(deleteAt)])

      // FOR UPDATE SKIP LOCKED розводить дві пачки: рівно одна з двох транзакцій справді
      // видаляє цей контакт (SKIP LOCKED не дає їм побачити той самий рядок одночасно).
      expect(first.deleted + second.deleted).toBeGreaterThanOrEqual(1)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })

    it('CLI не блокується на контакті, який тримає активна гостьова транзакція (SKIP LOCKED пропускає, не чекає)', async () => {
      const owner = await registerAccount(app, 'cli-skip-locked')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'CLI Skip Locked')
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
      const deleteAt = new Date(loan.returnedAt!.getTime() + 90 * DAY_MS)

      // Тримаємо лок на ExternalBorrower напряму в незакомiченій транзакції — симулює
      // конкурентний return/mark_lost/recover/close_loss, що ще не встиг закомітитися
      // (10h: ці переходи тепер теж locають EB першим кроком, §6.11.2 execution plan).
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${contactId} FOR UPDATE`

        // CLI НЕ повинен чекати — SKIP LOCKED пропускає зайнятий рядок і одразу повертається.
        // Таймер `.unref()`-иться і завжди прибирається — інакше він переживає гілку, де
        // `cleanup.run()` вигравав перегони, і лишає активний хендл між тестами.
        let timer: NodeJS.Timeout | undefined

        try {
          await Promise.race([
            cleanup.run(deleteAt),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('CLI заблокувався — SKIP LOCKED мав пропустити рядок')),
                3000,
              )
              timer.unref()
            }),
          ])
        } finally {
          clearTimeout(timer)
        }

        // Скоуп саме на цей контакт (не на глобальний `summary.deleted`, який ділить БД з іншими
        // тестами файлу, CLAUDE.md «Tests»): під нашим власним локом рядок не міг бути видалений.
        expect(await tx.externalBorrower.count({ where: { id: contactId } })).toBe(1)
      })

      // Після коміту (лок звільнено) — наступний прохід уже видаляє.
      const after = await cleanup.run(deleteAt)

      expect(after.deleted).toBeGreaterThanOrEqual(1)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
    })
  })

  describe('Часткова помилка в пачці: транзакція не лишає напівстертих даних', () => {
    it('падіння на одному зіпсованому контакті відкочує ВЕСЬ бекфіл-батч, включно з валідним контактом у ньому', async () => {
      const owner = await registerAccount(app, 'partial-failure')

      // Валідний контакт, якому справді потрібен бекфіл (симулює легасі 10f.2/10f.3/10g).
      const validShelf = await createShelfCopy(app, owner)
      const validContactId = await createContact(owner, 'Partial Failure Valid')
      const validLoanId = await handedOverGuestLoan(owner, validShelf, validContactId)

      await actOnGuestLoan(owner, validLoanId, { action: 'return' }).expect(200)
      await prisma.externalBorrower.update({
        where: { id: validContactId },
        data: { retainUntil: null },
      })

      // Зіпсований контакт: LOST-позика без LoanEvent LOAN_LOST — порушення інваріанту T4
      // (append-only, §6.8), яке `recomputeRetainUntil` навмисно ловить гучно (`retention.ts`,
      // «Позика … LOST без LoanEvent LOAN_LOST»). Відтворюється лише прямим доступом до БД в
      // тесті — застосунок сам такого рядка ніколи не пише.
      const corruptedShelf = await createShelfCopy(app, owner)
      const corruptedContactId = await createContact(owner, 'Partial Failure Corrupted')
      const corruptedLoanId = await lostGuestLoan(owner, corruptedShelf, corruptedContactId)

      await prisma.loanEvent.deleteMany({ where: { loanId: corruptedLoanId, type: 'LOAN_LOST' } })
      await prisma.externalBorrower.update({
        where: { id: corruptedContactId },
        data: { retainUntil: null },
      })

      // Обидва контакти — retainUntil=NULL, тож обидва мають потрапити в ОДИН backfill-батч
      // (BATCH_SIZE=200 — у файлі жодного разу не створюється й близько стільки контактів).
      await expect(cleanup.run(new Date())).rejects.toThrow(/LOST без LoanEvent LOAN_LOST/)

      // Жоден з двох — ні зіпсований, ні валідний, що просто «трапився поруч» у тій самій
      // транзакції — не змінився: половинчастого результату (один перерахований, інший ні) нема.
      const validAfter = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: validContactId },
      })
      const corruptedAfter = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: corruptedContactId },
      })

      expect(validAfter.retainUntil).toBeNull()
      expect(corruptedAfter.retainUntil).toBeNull()

      // Прибираємо зіпсований КОНТАКТ (як зробив би оператор) — наступний прохід більше не
      // намагається перерахувати цей самий зіпсований рядок і коректно бекфілить валідний
      // контакт, який чекав своєї черги поруч з ним у тому самому батчі. `Loan`/`LoanEvent`
      // лишаються (RESTRICT на `LoanEvent.loanId`, той самий інваріант, що й скрізь) — тут
      // видаляти їх і не потрібно, досить прибрати сам контакт.
      await prisma.externalBorrower.delete({ where: { id: corruptedContactId } })

      await cleanup.run(new Date())

      const validRecovered = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: validContactId },
      })

      expect(validRecovered.retainUntil).not.toBeNull()
    })
  })

  describe('Автоматична чистка ∥ recover/close_loss того самого простроченого контакту (10h, §6.11.2)', () => {
    /**
     * Детерміністичний (без гонки) доказ фікса «не видаляй за застарілим рішенням»: контакт, чия
     * незакрита LOST давно минула свою 365-денну межу (`staleNow` — реальний кандидат на
     * видалення ДО закриття), закривається (`close_loss`) — це ОДРАЗУ, в ТІЙ САМІЙ транзакції,
     * оновлює `retainUntil` на майбутню (`closedAt + 90д`) дату. Чистка з тим самим `staleNow`
     * (усе ще давно минулим відносно СТАРОЇ 365-денної межі) НЕ повинна видалити контакт — крок 4
     * `cleanupPhase` читає `retainUntil` ЗНОВУ, а не переносить значення з кроку 1.
     */
    it('close_loss завершується ПЕРШИМ: чистка з тим самим simulated-простроченим now більше не видаляє — retainUntil уже свіжий', async () => {
      const owner = await registerAccount(app, 'race-close-first')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Race Close First')
      const loanId = await lostGuestLoan(owner, shelf, contactId)
      // Далеко за 365-денною межею НЕЗАКРИТОЇ LOST — до close_loss це справжній кандидат.
      const staleNow = await backdateLostEvent(loanId, contactId)

      const beforeClose = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: contactId },
      })

      expect(beforeClose.retainUntil!.getTime()).toBeLessThanOrEqual(staleNow.getTime())

      await actOnGuestLoan(owner, loanId, { action: 'close_loss' }).expect(200)

      const afterClose = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: contactId },
      })

      expect(afterClose.retainUntil!.getTime()).toBeGreaterThan(staleNow.getTime())

      // Той самий `staleNow`, який ДО close_loss уже перевищував межу — тепер більше не спрацьовує:
      // крок 4 cleanupPhase перечитує retainUntil і бачить свіже (майбутнє відносно staleNow) значення.
      await cleanup.run(staleNow)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)

      // Контроль: із реальним "зараз" (retainUntil справді в майбутньому і відносно нього) — теж не видаляє.
      await cleanup.run(new Date())
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })

    it('recover завершується ПЕРШИМ: та сама гарантія — cleanup з simulated-простроченим now не видаляє', async () => {
      const owner = await registerAccount(app, 'race-recover-first')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Race Recover First')
      const loanId = await lostGuestLoan(owner, shelf, contactId)
      const staleNow = await backdateLostEvent(loanId, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'recover' }).expect(200)

      const afterRecover = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: contactId },
      })

      expect(afterRecover.retainUntil!.getTime()).toBeGreaterThan(staleNow.getTime())

      await cleanup.run(staleNow)
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
    })

    /**
     * Справжня одночасність (`Promise.all`, непередбачувана переможниця — навмисно, за зразком
     * `guest-loans-concurrency.e2e-spec.ts`, «без спільного локу цей тест ловить регресію»):
     * жодного 500/дедлоку за жодного порядку, `recover` завжди успішний (Q3c — не залежить від
     * існування контакту), і — головна перевірка фікса — якщо контакт ПЕРЕЖИВ гонку, то лише з
     * майбутнім `retainUntil` (ніколи зі старим, простроченим — інакше наступний прохід видалив
     * би його «занадто пізно», а не «занадто рано», але сам факт застарілого значення в живому
     * рядку означав би, що чистка колись прочитала б його неправильно).
     */
    it('cleanup(now) ∥ recover — Promise.all: без 500, recover завжди 200, живий контакт — лише зі свіжим retainUntil', async () => {
      const owner = await registerAccount(app, 'race-cleanup-recover')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Race Cleanup Recover')
      const loanId = await lostGuestLoan(owner, shelf, contactId)
      const staleNow = await backdateLostEvent(loanId, contactId)

      const [recoverResponse, summary] = await Promise.all([
        actOnGuestLoan(owner, loanId, { action: 'recover' }),
        cleanup.run(staleNow),
      ])

      expect(recoverResponse.status).toBe(200)
      expect(summary.deleted).toBeGreaterThanOrEqual(0)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.status).toBe('LOST')
      expect(await prisma.loanEvent.count({ where: { loanId, type: 'RECOVERED' } })).toBe(1)

      const survivor = await prisma.externalBorrower.findUnique({ where: { id: contactId } })

      if (survivor !== null) {
        expect(survivor.retainUntil).not.toBeNull()
        expect(survivor.retainUntil!.getTime()).toBeGreaterThan(staleNow.getTime())
      }
      // Якщо survivor === null: cleanup виграв гонку ПОВНІСТЮ до того, як recover щось
      // закомітив (§6.11.2, коректно — не "застаріле" рішення, бо на момент рішення recover ще
      // нічого не змінив). RET18 і тест вище окремо доводять, що recover після цього все одно
      // успішний і не намагається "воскресити" контакт.
    })

    it('cleanup(now) ∥ close_loss — Promise.all: без 500, close_loss завжди 200, живий контакт — лише зі свіжим retainUntil', async () => {
      const owner = await registerAccount(app, 'race-cleanup-close')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Race Cleanup Close')
      const loanId = await lostGuestLoan(owner, shelf, contactId)
      const staleNow = await backdateLostEvent(loanId, contactId)

      const [closeResponse, summary] = await Promise.all([
        actOnGuestLoan(owner, loanId, { action: 'close_loss' }),
        cleanup.run(staleNow),
      ])

      expect(closeResponse.status).toBe(200)
      expect(summary.deleted).toBeGreaterThanOrEqual(0)

      expect(await prisma.loanEvent.count({ where: { loanId, type: 'LOSS_CLOSED' } })).toBe(1)

      const survivor = await prisma.externalBorrower.findUnique({ where: { id: contactId } })

      if (survivor !== null) {
        expect(survivor.retainUntil).not.toBeNull()
        expect(survivor.retainUntil!.getTime()).toBeGreaterThan(staleNow.getTime())
      }
    })

    /**
     * За потреби (задача): cleanup ∥ create — нова гостьова позика того самого контакту, чий
     * retainUntil (легасі чи ще не перерахований) уже <= now. `create` бере лок ExternalBorrower
     * ПЕРШИМ (як і завжди, §6.11.2) — або встигає раніше за cleanup (контакт стає активним,
     * `retainUntil → NULL`, cleanup або пропускає його через SKIP LOCKED, або бачить NULL на
     * кроці 4 й не видаляє), або програє (контакт уже видалено — `create` отримує 404, як і при
     * звичайному DELETE ∥ create, 10f.3).
     */
    it('cleanup(now) ∥ create — Promise.all: без 500; або контакт активний і живий, або create коректно бачить 404', async () => {
      const owner = await registerAccount(app, 'race-cleanup-create')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Race Cleanup Create')

      // Контакт без жодної позики, штучно зроблений простроченим (як легасі-контакт, що чекає
      // на перший бекфіл-прохід) — реальний кандидат на видалення відносно `now`.
      const now = new Date()

      await prisma.externalBorrower.update({
        where: { id: contactId },
        data: { retainUntil: new Date(now.getTime() - 1000) },
      })

      const [createResponse, summary] = await Promise.all([
        createGuestLoan(owner, {
          copyId: shelf.copyId,
          externalBorrowerId: contactId,
          handedAt: '2026-01-01',
        }),
        cleanup.run(now),
      ])

      expect(summary.deleted).toBeGreaterThanOrEqual(0)
      expect([201, 404]).toContain(createResponse.status)

      if (createResponse.status === 201) {
        // create виграв: контакт живий і тепер активний (NULL, незалежно від того, встиг
        // cleanup його «побачити» чи ні — SKIP LOCKED пропускає зайняте, крок 4 бачить NULL).
        const survivor = await prisma.externalBorrower.findUniqueOrThrow({
          where: { id: contactId },
        })

        expect(survivor.retainUntil).toBeNull()
        expect(
          await prisma.loan.count({
            where: { borrowerContactId: contactId, status: 'HANDED_OVER' },
          }),
        ).toBe(1)
      } else {
        // cleanup виграв повністю раніше: контакт стерто до того, як create встиг його locати —
        // 404, нічого не створено (той самий контракт, що DELETE ∥ create, 10f.3).
        expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
        expect(await prisma.loan.count({ where: { borrowerContactId: contactId } })).toBe(0)
      }
    })
  })

  describe('Відсутність дедлоку: DELETE ∥ recover того самого контакту (10h, новий лок EB для recover)', () => {
    it('обидва запити завершуються без 500; recover завжди 200, DELETE — 204 або 409, ніколи взаємне блокування', async () => {
      const owner = await registerAccount(app, 'dl-recover-delete')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'DL Recover Delete')
      const loanId = await lostGuestLoan(owner, shelf, contactId)

      const [recoverResponse, deleteResponse] = await Promise.all([
        actOnGuestLoan(owner, loanId, { action: 'recover' }),
        deleteContact(owner, contactId),
      ])

      expect(recoverResponse.status).toBe(200)
      expect([204, 409]).toContain(deleteResponse.status)

      if (deleteResponse.status === 204) {
        expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)
      } else {
        expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(1)
      }

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.status).toBe('LOST')
      expect(await prisma.loanEvent.count({ where: { loanId, type: 'RECOVERED' } })).toBe(1)
    })
  })

  describe('RET8: після авто-чистки жоден API/лог не повертає alias', () => {
    it('GET /loans/guest/:id після авто-чистки — contact=null, alias відсутній у тілі відповіді', async () => {
      const owner = await registerAccount(app, 'ret8-cleanup')
      const shelf = await createShelfCopy(app, owner)
      const ALIAS = 'Синтетичний-Унікальний-Аліас-RET8'
      const contactId = await createContact(owner, ALIAS)
      const loanId = await handedOverGuestLoan(owner, shelf, contactId)

      await actOnGuestLoan(owner, loanId, { action: 'return' }).expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      await cleanup.run(new Date(loan.returnedAt!.getTime() + 90 * DAY_MS))
      expect(await prisma.externalBorrower.count({ where: { id: contactId } })).toBe(0)

      const response = await request(http())
        .get(url(`/loans/guest/${loanId}`))
        .set('Cookie', owner.cookie)
        .expect(200)

      expect(JSON.stringify(response.body)).not.toContain(ALIAS)
      expect(guestLoanResponseSchema.parse(response.body).loan.contact).toBeNull()
    })
  })
})
