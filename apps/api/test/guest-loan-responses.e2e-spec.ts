import './helpers/guest-loans-on'
import 'reflect-metadata'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import request from 'supertest'
import { Logger } from '@nestjs/common'
import {
  apiErrorSchema,
  answerGuestResponseResponseSchema,
  externalBorrowerResponseSchema,
  guestLoanConfirmationListResponseSchema,
  guestLoanConfirmationResponseSchema,
  issueGuestConfirmationLinkResponseSchema,
  myHistoryResponseSchema,
  requestGuestCodeResponseSchema,
  resolveGuestResponseResponseSchema,
  verifyGuestCodeResponseSchema,
  workHistoryResponseSchema,
  type ApiErrorCode,
  type GuestLoanConfirmation,
} from '@bookswap/shared'
import { createTestApp, uniqueEmail } from './auth.helpers'
import { beginRequest, deferred, waitForBlockedBackend } from './concurrency.helpers'
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
import { DevEmailSender } from '../src/email/dev-email-sender'
import { GuestConfirmationSecrets } from '../src/loans/guest-confirmation-secrets'
import { GuestContactRetentionCleanupService } from '../src/external-borrowers/guest-contact-retention-cleanup.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10i.2 (docs/plan/stage-10-real-world-history.md, §0.10–§0.13, §6.12, GC1–GC5, GC7–GC11,
 * GC13): видача посилання власником і ПУБЛІЧНА відповідь гостя без акаунта. Лише синтетичні дані
 * (D2): адреси — `@guest.invalid`, лист бере лише `DevEmailSender` (запечатане сховище, не лог).
 */
describe('Stage 10 (10i.2): гостьова відповідь на конкретну позику (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let mail: DevEmailSender
  let cleanup: GuestContactRetentionCleanupService
  let pg: Client
  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): ApiErrorCode => apiErrorSchema.parse(body).code
  const DAY_MS = 24 * 60 * 60 * 1000

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    mail = app.get(DevEmailSender)
    cleanup = new GuestContactRetentionCleanupService(prisma)
    pg = new Client({ connectionString: testDatabaseUrl() })
    await pg.connect()
  })

  afterAll(async () => {
    await pg.end()
    await app.close()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // --- Хелпери -----------------------------------------------------------------------------

  const synthetic = (prefix: string): string =>
    uniqueEmail(prefix).replace(/@.*$/, '@guest.invalid')

  async function createContact(account: Account, alias: string): Promise<string> {
    const response = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', account.cookie)
      .send({ alias, ownerInformed: true })
      .expect(201)

    return externalBorrowerResponseSchema.parse(response.body).contact.id
  }

  interface Ctx {
    owner: Account
    shelf: Shelf
    contactId: string
    confirmation: GuestLoanConfirmation
    alias: string
  }

  async function open(
    prefix: string,
    owner?: Account,
    beforeConfirm?: (shelf: Shelf) => Promise<void>,
  ): Promise<Ctx> {
    const who = owner ?? (await registerAccount(app, prefix))
    const shelf = await createShelfCopy(app, who)
    const alias = `Гість ${prefix}`
    const contactId = await createContact(who, alias)

    // Конкурентні REQUESTED можливі лише ДО запиту підтвердження (після нього примірник зарезервований).
    await beforeConfirm?.(shelf)

    const created = await request(http())
      .post(url('/guest-loan-confirmations'))
      .set('Cookie', who.cookie)
      .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
      .expect(201)

    return {
      owner: who,
      shelf,
      contactId,
      alias,
      confirmation: guestLoanConfirmationResponseSchema.parse(created.body).confirmation,
    }
  }

  const ownerCall = (
    method: 'get' | 'post' | 'patch' | 'delete',
    owner: Account,
    path: string,
  ): request.Test => request(http())[method](url(path)).set('Cookie', owner.cookie)

  const issue = (owner: Account, id: string, body: object): request.Test =>
    ownerCall('post', owner, `/guest-loan-confirmations/${id}/link`).send(body)

  const tokenOfUrl = (link: string | null): string => {
    const match = /#([A-Za-z0-9_%-]+)$/.exec(link ?? '')

    if (match?.[1] === undefined) throw new Error('У відповіді немає посилання з токеном')

    return decodeURIComponent(match[1])
  }

  async function issueCopy(ctx: Pick<Ctx, 'owner' | 'confirmation'>): Promise<string> {
    const response = await issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }).expect(201)

    return tokenOfUrl(issueGuestConfirmationLinkResponseSchema.parse(response.body).url)
  }

  /** Лист із посиланням — з ЗАПЕЧАТАНОГО сховища транспорту (не з логу). */
  function tokenFromLetter(to: string): string {
    const letter = mail.sealedTo(to)

    if (letter === undefined) throw new Error('Листа з посиланням немає')

    const match = /guest-loan-confirmation#([A-Za-z0-9_%-]+)/.exec(letter.body)

    if (match?.[1] === undefined) throw new Error('У листі немає токена')

    return decodeURIComponent(match[1])
  }

  function codeFromLetter(to: string): string {
    const match = /Код підтвердження: (\d{6})/.exec(mail.sealedTo(to)?.body ?? '')

    if (match?.[1] === undefined) throw new Error('У листі немає коду')

    return match[1]
  }

  const pub = (path: string, body: object): request.Test =>
    request(http())
      .post(url(`/guest-loan-responses/${path}`))
      .send(body)

  interface Guest {
    token: string
    nickname: string
    email: string
  }

  async function sendCode(guest: Guest): Promise<string> {
    await pub('code', guest).expect(200)

    return codeFromLetter(guest.email)
  }

  async function proofOf(guest: Guest): Promise<string> {
    const code = await sendCode(guest)
    const response = await pub('verify', { ...guest, code }).expect(200)

    return verifyGuestCodeResponseSchema.parse(response.body).proof
  }

  const answerWith = (guest: Guest, proof: string, answer: 'RECEIVED' | 'DENIED'): request.Test =>
    pub('answer', { ...guest, proof, answer })

  async function respond(guest: Guest, answer: 'RECEIVED' | 'DENIED'): Promise<void> {
    const proof = await proofOf(guest)
    const response = await answerWith(guest, proof, answer).expect(200)

    expect(answerGuestResponseResponseSchema.parse(response.body)).toEqual({ answer })
  }

  const guestFor = (token: string, prefix = 'g10i2'): Guest => ({
    token,
    nickname: `Нік ${prefix} ${String(Date.now())}`,
    email: synthetic(prefix),
  })

  async function confirmationOf(ctx: Pick<Ctx, 'owner' | 'confirmation'>) {
    const response = await ownerCall(
      'get',
      ctx.owner,
      `/guest-loan-confirmations/${ctx.confirmation.id}`,
    ).expect(200)

    return guestLoanConfirmationResponseSchema.parse(response.body).confirmation
  }

  async function rowOf(id: string) {
    return prisma.guestLoanConfirmation.findUniqueOrThrow({ where: { id } })
  }

  /** Бізнес-стан, який жодна відхилена спроба не має змінити (лічильники кодів сюди не входять). */
  async function businessState(ctx: Pick<Ctx, 'shelf' | 'confirmation' | 'contactId'>) {
    return {
      copy: await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } }),
      loans: await prisma.loan.findMany({
        where: { copyId: ctx.shelf.copyId },
        orderBy: { id: 'asc' },
      }),
      events: await prisma.loanEvent.findMany({
        where: { loan: { copyId: ctx.shelf.copyId } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
      status: (await rowOf(ctx.confirmation.id)).status,
      contact: await prisma.externalBorrower.findUniqueOrThrow({ where: { id: ctx.contactId } }),
    }
  }

  async function expireLink(id: string): Promise<void> {
    const expiresAt = new Date(Date.now() - 1000)

    await prisma.guestLoanConfirmation.update({
      where: { id },
      data: { linkIssuedAt: new Date(expiresAt.getTime() - 7 * DAY_MS), linkExpiresAt: expiresAt },
    })
  }

  const eventTypes = async (loanId: string): Promise<string[]> =>
    (
      await prisma.loanEvent.findMany({
        where: { loanId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })
    ).map((event) => event.type)

  /** У яких таблицях (усі BASE TABLE схеми public) значення зустрічається хоч раз — як текст рядка. */
  async function tablesContaining(needle: string): Promise<string[]> {
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`,
    )
    const found: string[] = []

    for (const { table_name: table } of tables.rows) {
      const result = await pg.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "${table}" x WHERE strpos(to_jsonb(x)::text, $1) > 0`,
        [needle],
      )

      if ((result.rows[0]?.count ?? 0) > 0) found.push(table)
    }

    return found
  }

  function captureLogs(): () => string {
    const lines: string[] = []
    const push =
      () =>
      (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(' '))
      }

    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(push())
    }

    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation(push())
    }

    return () => lines.join('\n')
  }

  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

  // --- GC1: видача посилання власником -------------------------------------------------------

  describe('GC1: видача посилання (owner-only, OPEN)', () => {
    it('COPY: посилання діє рівно 7 днів від серверного часу видачі; токен зберігається лише як геш', async () => {
      const ctx = await open('gc1-copy')
      const before = Date.now()
      const response = await issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }).expect(201)
      const after = Date.now()
      const body = issueGuestConfirmationLinkResponseSchema.parse(response.body)
      const token = tokenOfUrl(body.url)

      expect(body.delivery).toBe('COPY')
      expect(body.url).toMatch(/\/guest-loan-confirmation#/)
      expect(body.confirmation.status).toBe('OPEN')

      const link = body.confirmation.link

      expect(link).not.toBeNull()
      expect(link?.isExpired).toBe(false)

      const issuedAt = new Date(link?.issuedAt ?? 0).getTime()
      const expiresAt = new Date(link?.expiresAt ?? 0).getTime()

      expect(issuedAt).toBeGreaterThanOrEqual(before)
      expect(issuedAt).toBeLessThanOrEqual(after)
      expect(expiresAt - issuedAt).toBe(7 * DAY_MS)

      const row = await rowOf(ctx.confirmation.id)

      expect(row.linkTokenHash).toBe(sha256(token))
      expect(JSON.stringify(row)).not.toContain(token)
      expect(await tablesContaining(token)).toEqual([])

      // Власник читає стан посилання, але не сам токен.
      const read = await confirmationOf(ctx)

      expect(read.link).toEqual(link)
      expect(JSON.stringify(read)).not.toContain(token)

      // Видача посилання не чіпає позику, примірник і аудит.
      expect(await eventTypes(ctx.confirmation.loan.id)).toEqual(['GUEST_CONFIRMATION_REQUESTED'])
      expect(
        (await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } })).status,
      ).toBe('PENDING_CONFIRMATION')
    })

    it('EMAIL: лист іде на адресу власника A лише через транзакційний dev-транспорт; A не повертається і не зберігається', async () => {
      const ctx = await open('gc1-mail')
      const address = synthetic('deliver-a')
      const readLogs = captureLogs()
      const response = await issue(ctx.owner, ctx.confirmation.id, {
        delivery: 'EMAIL',
        email: address,
      }).expect(201)
      const body = issueGuestConfirmationLinkResponseSchema.parse(response.body)
      const token = tokenFromLetter(address)

      expect(body.delivery).toBe('EMAIL')
      expect(body.url).toBeNull()
      expect(JSON.stringify(response.body)).not.toContain(address)
      expect(JSON.stringify(response.body)).not.toContain(token)
      expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBe(sha256(token))
      expect(body.confirmation.link?.isExpired).toBe(false)

      // Лист несе посилання й не називає ні alias гостя, ні id; звичайний outbox порожній.
      const letter = mail.sealedTo(address)

      expect(letter?.body).toContain('7 днів')
      expect(letter?.body).not.toContain(ctx.alias)
      expect(mail.lastTo(address)).toBeUndefined()

      // Ні адреса A, ні токен не потрапили в БД (жодна таблиця) і в логи.
      expect(await tablesContaining(address)).toEqual([])
      expect(await tablesContaining(token)).toEqual([])
      expect(readLogs()).not.toContain(address)
      expect(readLogs()).not.toContain(token)
    })

    it('валідація: EMAIL без адреси, COPY з адресою, реальний домен, зайві поля — 400 без видачі', async () => {
      const ctx = await open('gc1-valid')

      for (const body of [
        { delivery: 'EMAIL' },
        { delivery: 'COPY', email: synthetic('x') },
        { delivery: 'EMAIL', email: 'real@example.com' },
        { delivery: 'EMAIL', email: 'not-an-email' },
        { delivery: 'SMS' },
        { delivery: 'COPY', extra: 1 },
        {},
      ]) {
        const response = await issue(ctx.owner, ctx.confirmation.id, body)

        expect(response.status).toBe(400)
        expect(errorCode(response.body)).toBe('VALIDATION_ERROR')
      }

      expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBeNull()
      expect((await confirmationOf(ctx)).link).toBeNull()
    })

    it('чужий власник — 404, без сесії — 401; посилання чужому запиту не видається', async () => {
      const ctx = await open('gc1-auth')
      const stranger = await registerAccount(app, 'gc1-stranger')

      const foreign = await issue(stranger, ctx.confirmation.id, { delivery: 'COPY' })

      expect(foreign.status).toBe(404)
      expect(errorCode(foreign.body)).toBe('NOT_FOUND')

      const missing = await issue(ctx.owner, 'no-such-id', { delivery: 'COPY' })

      expect(missing.status).toBe(404)

      const anonymous = await request(http())
        .post(url(`/guest-loan-confirmations/${ctx.confirmation.id}/link`))
        .send({ delivery: 'COPY' })

      expect(anonymous.status).toBe(401)
      expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBeNull()
    })

    it('не з OPEN (DENIED, RECEIVED, CANCELLED, OWNER_RECORDED) посилання не видається — 409 GUEST_LINK_NOT_ISSUABLE', async () => {
      const denied = await open('gc1-denied')
      const deniedGuest = guestFor(await issueCopy(denied))

      await respond(deniedGuest, 'DENIED')

      const received = await open('gc1-received')

      await respond(guestFor(await issueCopy(received)), 'RECEIVED')

      const cancelled = await open('gc1-cancelled')

      await ownerCall(
        'patch',
        cancelled.owner,
        `/guest-loan-confirmations/${cancelled.confirmation.id}`,
      )
        .send({ action: 'cancel_handover', bookIsWithOwner: true })
        .expect(200)

      const recorded = await open('gc1-recorded')

      await ownerCall(
        'patch',
        recorded.owner,
        `/guest-loan-confirmations/${recorded.confirmation.id}`,
      )
        .send({ action: 'record_owner_statement' })
        .expect(200)

      for (const ctx of [denied, received, cancelled, recorded]) {
        const response = await issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' })

        expect(response.status).toBe(409)
        expect(errorCode(response.body)).toBe('GUEST_LINK_NOT_ISSUABLE')
        expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBeNull()
      }
    })

    it('збій листа: 502, посилання гаситься (жодного чинного токена без отримувача)', async () => {
      const ctx = await open('gc1-fail')
      const address = synthetic('deliver-fail')

      jest.spyOn(mail, 'send').mockRejectedValueOnce(new Error('транспорт недоступний'))

      const response = await issue(ctx.owner, ctx.confirmation.id, {
        delivery: 'EMAIL',
        email: address,
      })

      expect(response.status).toBe(502)
      expect(errorCode(response.body)).toBe('GUEST_LINK_EMAIL_FAILED')
      expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBeNull()
      expect((await confirmationOf(ctx)).link).toBeNull()
      expect(await tablesContaining(address)).toEqual([])
    })

    it('ротація: повторна видача негайно гасить попереднє посилання, код і доказ; нове — чинне', async () => {
      const ctx = await open('gc1-rotate')
      const first = await issueCopy(ctx)
      const guest = guestFor(first)
      const proof = await proofOf(guest)
      const code = await sendCode(guest)

      await pub('resolve', { token: first }).expect(200)

      const second = await issueCopy(ctx)

      expect(second).not.toBe(first)

      // Старе посилання мертве в усіх маршрутах — однією й тією самою помилкою.
      for (const [path, body] of [
        ['resolve', { token: first }],
        ['code', guest],
        ['verify', { ...guest, code }],
        ['answer', { ...guest, proof, answer: 'RECEIVED' }],
      ] as const) {
        const response = await pub(path, body)

        expect(response.status).toBe(404)
        expect(errorCode(response.body)).toBe('GUEST_LINK_INVALID')
      }

      // Новий токен не успадковує ні доказ, ні код зі старого посилання.
      const fresh = { ...guest, token: second }
      const stale = await answerWith(fresh, proof, 'RECEIVED')

      expect(stale.status).toBe(403)
      expect(errorCode(stale.body)).toBe('GUEST_PROOF_INVALID')

      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeHash).toBeNull()
      expect(row.proofHash).toBeNull()
      expect(row.codeSentCount).toBe(0)
      expect(row.codeFailedTotal).toBe(0)
      await respond(fresh, 'RECEIVED')
    })
  })

  // --- GC2/GC3/GC13: публічний шлях -----------------------------------------------------------

  describe('GC2/GC3: публічна сторінка конкретної позики без акаунта', () => {
    it('resolve віддає лише книжку й строк — без email, alias, id контакту чи власника', async () => {
      const ctx = await open('gc3-resolve')
      const token = await issueCopy(ctx)
      const response = await pub('resolve', { token }).expect(200)
      const body = resolveGuestResponseResponseSchema.parse(response.body)

      expect(body.book.title).toMatch(/^Полиця/)
      expect(body.book.authors[0]).toMatch(/^Полицівський/)
      expect(body).not.toHaveProperty('handedAt')
      expect(Object.keys(response.body as object).sort()).toEqual(['book', 'expiresAt'])

      const text = JSON.stringify(response.body)

      for (const secret of [ctx.alias, ctx.contactId, ctx.owner.id, ctx.owner.displayName]) {
        expect(text).not.toContain(secret)
      }
    })

    it('невідомий токен, порожнє тіло і вигадане поле — без розкриття стану; сесія не потрібна', async () => {
      expect((await pub('resolve', { token: 'no-such-token' })).status).toBe(404)
      expect(errorCode((await pub('resolve', { token: 'no-such-token' })).body)).toBe(
        'GUEST_LINK_INVALID',
      )
      expect((await pub('resolve', {})).status).toBe(400)
      expect((await pub('resolve', { token: 'x', extra: 1 })).status).toBe(400)
      expect((await pub('resolve', { token: '' })).status).toBe(400)
    })

    it('GC13: адресний лист на A, гість підтверджує ІНШУ адресу B — відповідь не відхиляється; у контакті лише B і нікнейм; alias власника не змінено', async () => {
      const ctx = await open('gc13-received')
      const a = synthetic('deliver-a13')
      const b = synthetic('guest-b13')
      const nickname = `Нік-${String(Date.now())}`
      const readLogs = captureLogs()

      await issue(ctx.owner, ctx.confirmation.id, { delivery: 'EMAIL', email: a }).expect(201)

      const token = tokenFromLetter(a)
      const guest: Guest = { token, nickname, email: b }
      const usersBefore = await prisma.user.count()
      const codeAt = Date.now()
      const proof = await proofOf(guest)

      // Код пішов на B, а не на A; A має лише лист із посиланням.
      expect(mail.sealedTo(b)?.body).toMatch(/Код підтвердження: \d{6}/)
      expect(mail.sealedTo(a)?.body).not.toMatch(/Код підтвердження/)

      const answeredAt = Date.now()

      await answerWith(guest, proof, 'RECEIVED').expect(200)

      // Атомарно: Loan/Copy/підтвердження/аудит.
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } })
      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })
      const row = await rowOf(ctx.confirmation.id)

      expect(loan.status).toBe('HANDED_OVER')
      expect(copy).toMatchObject({
        status: 'LENT_OUT',
        currentHolderId: null,
        heldByContactId: ctx.contactId,
      })
      expect(row.status).toBe('RECEIVED')
      expect(row.resolvedAt).not.toBeNull()
      expect(row).toMatchObject({
        linkTokenHash: null,
        linkIssuedAt: null,
        linkExpiresAt: null,
        challengeMac: null,
        codeHash: null,
        proofHash: null,
        verifiedAt: null,
      })

      const events = await prisma.loanEvent.findMany({
        where: { loanId: loan.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })

      expect(events.map((event) => event.type)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_RECEIVED',
      ])
      expect(events[1]).toMatchObject({ actorId: null, payload: {} })

      // Приватний запис у контакті: підтверджені нікнейм і B з часом перевірки коду; alias — без змін.
      const contact = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: ctx.contactId },
      })

      expect(contact).toMatchObject({
        alias: ctx.alias,
        guestNickname: nickname,
        guestEmail: b,
      })
      expect(contact.guestEmailVerifiedAt?.getTime()).toBeGreaterThanOrEqual(codeAt)
      expect(contact.guestEmailVerifiedAt?.getTime()).toBeLessThanOrEqual(answeredAt)
      expect(contact.retainUntil).toBeNull()

      // Власник бачить підтверджене приватно; це «підтверджено гостем», не «зі слів власника».
      const read = await confirmationOf(ctx)

      expect(read).toMatchObject({
        status: 'RECEIVED',
        evidence: 'GUEST_CONFIRMED',
        link: null,
        loan: { status: 'HANDED_OVER' },
        contact: { alias: ctx.alias, guestNickname: nickname, guestEmail: b },
      })
      expect(await prisma.user.count()).toBe(usersBefore)

      // A ніде не осіла; B і нікнейм — лише в ExternalBorrower; токен/доказ — ніде відкритими.
      expect(await tablesContaining(a)).toEqual([])
      expect(await tablesContaining(b)).toEqual(['ExternalBorrower'])
      expect(await tablesContaining(nickname)).toEqual(['ExternalBorrower'])
      expect(await tablesContaining(token)).toEqual([])
      expect(await tablesContaining(proof)).toEqual([])
      expect(readLogs()).not.toContain(a)
      expect(readLogs()).not.toContain(b)
      expect(readLogs()).not.toContain(nickname)
      expect(readLogs()).not.toContain(token)
      expect(readLogs()).not.toContain(proof)
    })

    it('самостійно передане посилання: без адреси доставки, без схвалення власником — те саме підтвердження напряму', async () => {
      const ctx = await open('gc3-copy')
      const guest = guestFor(await issueCopy(ctx), 'gc3-copy')

      await respond(guest, 'RECEIVED')

      const read = await confirmationOf(ctx)

      expect(read).toMatchObject({ status: 'RECEIVED', evidence: 'GUEST_CONFIRMED' })
      expect(read.loan.status).toBe('HANDED_OVER')
      expect(read.contact).toMatchObject({ guestNickname: guest.nickname, guestEmail: guest.email })
      // Жодної дії власника між відповіддю й підтвердженням: у аудиті лише запит і відповідь.
      expect(await eventTypes(ctx.confirmation.loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_RECEIVED',
      ])
    })

    it('«Отримав» відхиляє конкурентні REQUESTED атомарно зі сповіщенням; «Не отримував» їх не чіпає', async () => {
      const owner = await registerAccount(app, 'gc2-rival-owner')
      const rival = await registerAccount(app, 'gc2-rival')

      await befriend(app, owner, rival)

      let rivalLoanId = ''
      let deniedRivalId = ''
      const received = await open('gc2-rival-a', owner, async (shelf) => {
        const sent = await requestLoan(app, rival, shelf.copyId).expect(201)

        rivalLoanId = (sent.body as { loan: { id: string } }).loan.id
      })
      const denied = await open('gc2-rival-b', owner, async (shelf) => {
        const sent = await requestLoan(app, rival, shelf.copyId).expect(201)

        deniedRivalId = (sent.body as { loan: { id: string } }).loan.id
      })

      await respond(guestFor(await issueCopy(denied), 'gc2-rival-b'), 'DENIED')

      expect((await prisma.loan.findUniqueOrThrow({ where: { id: deniedRivalId } })).status).toBe(
        'REQUESTED',
      )
      expect(
        await prisma.notification.count({ where: { userId: rival.id, type: 'LOAN_REJECTED' } }),
      ).toBe(0)

      await respond(guestFor(await issueCopy(received), 'gc2-rival-a'), 'RECEIVED')

      const rejected = await prisma.loan.findUniqueOrThrow({ where: { id: rivalLoanId } })

      expect(rejected.status).toBe('REJECTED')
      expect(rejected.respondedAt).not.toBeNull()
      expect(
        await prisma.notification.count({ where: { userId: rival.id, type: 'LOAN_REJECTED' } }),
      ).toBe(1)
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: deniedRivalId } })).status).toBe(
        'REQUESTED',
      )
    })

    it('нова підтверджена відповідь того самого контакту замінює попередні гостьові значення; alias власника лишається', async () => {
      const ctx = await open('gc2-replace')
      const first = guestFor(await issueCopy(ctx), 'gc2-first')

      await respond(first, 'RECEIVED')

      const firstVerifiedAt = (
        await prisma.externalBorrower.findUniqueOrThrow({ where: { id: ctx.contactId } })
      ).guestEmailVerifiedAt

      await ownerCall('patch', ctx.owner, `/loans/guest/${ctx.confirmation.loan.id}`)
        .send({ action: 'return' })
        .expect(200)

      // Друга передача тієї самої книжки тому самому контакту й нова відповідь з іншими значеннями.
      const second = await request(http())
        .post(url('/guest-loan-confirmations'))
        .set('Cookie', ctx.owner.cookie)
        .send({
          copyId: ctx.shelf.copyId,
          externalBorrowerId: ctx.contactId,
          handedAt: '2026-02-01',
        })
        .expect(201)
      const secondConfirmation = guestLoanConfirmationResponseSchema.parse(second.body).confirmation
      const secondGuest = guestFor(
        await issueCopy({ owner: ctx.owner, confirmation: secondConfirmation }),
        'gc2-second',
      )

      await respond(secondGuest, 'DENIED')

      const contact = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: ctx.contactId },
      })

      expect(contact.alias).toBe(ctx.alias)
      expect(contact.guestNickname).toBe(secondGuest.nickname)
      expect(contact.guestEmail).toBe(secondGuest.email)
      expect(contact.guestEmailVerifiedAt?.getTime()).toBeGreaterThan(
        firstVerifiedAt?.getTime() ?? Infinity,
      )
      // Старі значення не лишилися ніде.
      expect(await tablesContaining(first.email)).toEqual([])
      expect(await tablesContaining(first.nickname)).toEqual([])
    })
  })

  // --- GC5: «Не отримував» ------------------------------------------------------------------

  describe('GC5: «Не отримував» — розбіжність, а не повернення', () => {
    it('DENIED: Loan=PENDING_CONFIRMATION, Copy=RESERVED, аудит; контакт записано; нового посилання немає; токен одноразовий', async () => {
      const ctx = await open('gc5-denied')
      const token = await issueCopy(ctx)
      const guest = guestFor(token, 'gc5')
      const proof = await proofOf(guest)

      await answerWith(guest, proof, 'DENIED').expect(200)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } })
      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })
      const row = await rowOf(ctx.confirmation.id)

      expect(loan.status).toBe('PENDING_CONFIRMATION')
      expect(copy).toMatchObject({
        status: 'RESERVED',
        currentHolderId: null,
        heldByContactId: ctx.contactId,
      })
      expect(row.status).toBe('DENIED')
      expect(row.resolvedAt).toBeNull()
      expect(row.linkTokenHash).toBeNull()
      expect(await eventTypes(loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_DENIED',
      ])

      const contact = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: ctx.contactId },
      })

      expect(contact).toMatchObject({
        alias: ctx.alias,
        guestNickname: guest.nickname,
        guestEmail: guest.email,
      })
      expect(contact.retainUntil).toBeNull()

      // Одноразова відповідь: токен і доказ мертві, нове посилання не видається.
      const replay = await answerWith(guest, proof, 'RECEIVED')

      expect(replay.status).toBe(404)
      expect(errorCode(replay.body)).toBe('GUEST_LINK_INVALID')
      expect((await issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' })).status).toBe(409)

      const read = await confirmationOf(ctx)

      expect(read).toMatchObject({ status: 'DENIED', evidence: 'GUEST_DENIED', link: null })
    })

    it('заперечення лишається в аудиті й після рішення власника: скасування передачі і запис зі слів власника', async () => {
      const cancelled = await open('gc5-cancel')

      await respond(guestFor(await issueCopy(cancelled), 'gc5-c'), 'DENIED')
      await ownerCall(
        'patch',
        cancelled.owner,
        `/guest-loan-confirmations/${cancelled.confirmation.id}`,
      )
        .send({ action: 'cancel_handover', bookIsWithOwner: true })
        .expect(200)

      expect(await eventTypes(cancelled.confirmation.loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_DENIED',
        'GUEST_HANDOVER_CANCELLED',
      ])
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: cancelled.shelf.copyId } })).status,
      ).toBe('AVAILABLE')

      const recorded = await open('gc5-record')

      await respond(guestFor(await issueCopy(recorded), 'gc5-r'), 'DENIED')

      const response = await ownerCall(
        'patch',
        recorded.owner,
        `/guest-loan-confirmations/${recorded.confirmation.id}`,
      )
        .send({ action: 'record_owner_statement' })
        .expect(200)
      const after = guestLoanConfirmationResponseSchema.parse(response.body).confirmation

      // Запис зі слів власника НЕ перетворюється на «підтверджено гостем», але заперечення в аудиті лишилось.
      expect(after.evidence).toBe('OWNER_STATEMENT')
      expect(after.loan.status).toBe('HANDED_OVER')
      expect(await eventTypes(recorded.confirmation.loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_DENIED',
        'GUEST_LOAN_OWNER_RECORDED',
      ])
    })

    it('історія розрізняє слова власника, очікування, підтвердження й заперечення; старий запис 10f.3 не стає підтвердженим', async () => {
      const owner = await registerAccount(app, 'gc5-history-owner')
      const friend = await registerAccount(app, 'gc5-history-friend')

      await befriend(app, owner, friend)

      const awaiting = await open('gc5-h-await', owner)
      const denied = await open('gc5-h-denied', owner)
      const received = await open('gc5-h-received', owner)

      await issueCopy(awaiting)
      await respond(guestFor(await issueCopy(denied), 'gc5-h-d'), 'DENIED')
      await respond(guestFor(await issueCopy(received), 'gc5-h-r'), 'RECEIVED')

      // Старий ручний запис 10f.3: одразу HANDED_OVER, без рядка підтвердження.
      const legacyShelf = await createShelfCopy(app, owner)
      const legacyContact = await createContact(owner, 'Гість legacy')

      await ownerCall('post', owner, '/loans/guest')
        .send({
          copyId: legacyShelf.copyId,
          externalBorrowerId: legacyContact,
          handedAt: '2026-01-01',
        })
        .expect(201)

      const mine = await ownerCall('get', owner, '/me/history').expect(200)
      const evidenceOf = (copyId: string): unknown =>
        myHistoryResponseSchema.parse(mine.body).lent.find((item) => item.copy.id === copyId)?.entry
          .guestEvidence

      expect(evidenceOf(awaiting.shelf.copyId)).toBe('AWAITING_GUEST')
      expect(evidenceOf(denied.shelf.copyId)).toBe('GUEST_DENIED')
      expect(evidenceOf(received.shelf.copyId)).toBe('GUEST_CONFIRMED')
      expect(evidenceOf(legacyShelf.copyId)).toBe('OWNER_STATEMENT')

      // Друг у публічній історії бачить лише підтверджений гостем факт (без імен); очікування й заперечення — ні.
      for (const [shelf, expected] of [
        [awaiting.shelf, []],
        [denied.shelf, []],
        [received.shelf, ['GUEST_CONFIRMED']],
        [legacyShelf, ['OWNER_STATEMENT']],
      ] as const) {
        const work = await request(http())
          .get(url(`/works/${shelf.workId}/history`))
          .set('Cookie', friend.cookie)
          .expect(200)
        const entries = workHistoryResponseSchema.parse(work.body).entries

        expect(entries.map((item) => item.entry.guestEvidence)).toEqual(expected)
        expect(entries.every((item) => !item.entry.names)).toBe(true)
      }
    })
  })

  // --- GC2: код, доказ, токен ----------------------------------------------------------------

  describe('GC2/GC9: одноразовий код, доказ і токен', () => {
    it('без доказу відповісти не можна: 403 і нічого не змінюється', async () => {
      const ctx = await open('gc2-noproof')
      const guest = guestFor(await issueCopy(ctx), 'gc2-noproof')
      const before = await businessState(ctx)

      for (const proof of ['ne-proof', 'x'.repeat(43)]) {
        const response = await answerWith(guest, proof, 'RECEIVED')

        expect(response.status).toBe(403)
        expect(errorCode(response.body)).toBe('GUEST_PROOF_INVALID')
      }

      // Код надіслано, але не введено — відповісти теж не можна.
      await sendCode(guest)
      expect((await answerWith(guest, 'ne-proof', 'DENIED')).status).toBe(403)
      expect(await businessState(ctx)).toEqual(before)
    })

    it('хибний код — 400, стан не змінюється; правильний після нього ще діє (до вичерпання)', async () => {
      const ctx = await open('gc2-wrong')
      const guest = guestFor(await issueCopy(ctx), 'gc2-wrong')
      const code = await sendCode(guest)
      const wrong = code === '000000' ? '000001' : '000000'
      const before = await businessState(ctx)
      const response = await pub('verify', { ...guest, code: wrong })

      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('GUEST_CODE_INVALID')
      expect(await businessState(ctx)).toEqual(before)
      expect((await rowOf(ctx.confirmation.id)).codeAttempts).toBe(1)
      await pub('verify', { ...guest, code }).expect(200)
    })

    it('код прив’язаний до адреси B і нікнейма: той самий код для іншої адреси чи нікнейма не працює', async () => {
      const ctx = await open('gc2-bound')
      const guest = guestFor(await issueCopy(ctx), 'gc2-bound')
      const code = await sendCode(guest)

      for (const other of [
        { ...guest, email: synthetic('gc2-bound-other') },
        { ...guest, nickname: `${guest.nickname}!` },
      ]) {
        const response = await pub('verify', { ...other, code })

        expect(response.status).toBe(400)
        expect(errorCode(response.body)).toBe('GUEST_CODE_INVALID')
      }

      await pub('verify', { ...guest, code }).expect(200)
    })

    it('код прив’язаний до конкретного підтвердження: код іншої позики тієї самої адреси не працює', async () => {
      const one = await open('gc2-cross-1')
      const two = await open('gc2-cross-2')
      const shared = synthetic('gc2-cross')
      const guestOne: Guest = { token: await issueCopy(one), nickname: 'Спільний', email: shared }
      const guestTwo: Guest = { token: await issueCopy(two), nickname: 'Спільний', email: shared }
      const codeOne = await sendCode(guestOne)

      await sendCode(guestTwo)

      // Код першої позики на другому посиланні (де активний інший код) — хибний.
      if (codeOne !== codeFromLetter(shared)) {
        expect((await pub('verify', { ...guestTwo, code: codeOne })).status).toBe(400)
      }

      // Доказ першої позики не відповідає на другу.
      const proofOne = (await pub('verify', { ...guestOne, code: codeOne }).expect(200)).body as {
        proof: string
      }
      const foreign = await answerWith(guestTwo, proofOne.proof, 'RECEIVED')

      expect(foreign.status).toBe(403)
      expect((await rowOf(two.confirmation.id)).status).toBe('OPEN')
    })

    it('код одноразовий: після успішної перевірки повторити його не можна; доказ — теж лише раз', async () => {
      const ctx = await open('gc2-reuse')
      const guest = guestFor(await issueCopy(ctx), 'gc2-reuse')
      const code = await sendCode(guest)
      const proof = verifyGuestCodeResponseSchema.parse(
        (await pub('verify', { ...guest, code }).expect(200)).body,
      ).proof

      const again = await pub('verify', { ...guest, code })

      expect(again.status).toBe(400)
      expect(errorCode(again.body)).toBe('GUEST_CODE_INVALID')

      await answerWith(guest, proof, 'RECEIVED').expect(200)

      const replay = await answerWith(guest, proof, 'RECEIVED')

      expect(replay.status).toBe(404)
      expect(errorCode(replay.body)).toBe('GUEST_LINK_INVALID')
      expect(await eventTypes(ctx.confirmation.loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_RECEIVED',
      ])
    })

    it('прострочений код (10 хв) і прострочений доказ (30 хв) не діють', async () => {
      const ctx = await open('gc2-ttl')
      const guest = guestFor(await issueCopy(ctx), 'gc2-ttl')
      const code = await sendCode(guest)
      const row = await rowOf(ctx.confirmation.id)

      expect((row.codeExpiresAt?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(10 * 60_000)
      await prisma.guestLoanConfirmation.update({
        where: { id: ctx.confirmation.id },
        data: { codeExpiresAt: new Date(Date.now() - 1000) },
      })

      const expired = await pub('verify', { ...guest, code })

      expect(expired.status).toBe(400)
      expect(errorCode(expired.body)).toBe('GUEST_CODE_INVALID')

      const proof = await proofOf(guest)

      await prisma.guestLoanConfirmation.update({
        where: { id: ctx.confirmation.id },
        data: { proofExpiresAt: new Date(Date.now() - 1000) },
      })

      const late = await answerWith(guest, proof, 'RECEIVED')

      expect(late.status).toBe(403)
      expect(errorCode(late.body)).toBe('GUEST_PROOF_INVALID')
      expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
    })

    it('доказ прив’язаний до адреси й нікнейма: з іншою адресою чи нікнеймом відповісти не можна', async () => {
      const ctx = await open('gc2-proofbound')
      const guest = guestFor(await issueCopy(ctx), 'gc2-proofbound')
      const proof = await proofOf(guest)

      for (const other of [
        { ...guest, email: synthetic('gc2-proofbound-x') },
        { ...guest, nickname: 'Підміна' },
      ]) {
        const response = await answerWith(other, proof, 'RECEIVED')

        expect(response.status).toBe(403)
        expect(errorCode(response.body)).toBe('GUEST_PROOF_INVALID')
      }

      expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
      await answerWith(guest, proof, 'RECEIVED').expect(200)
    })

    it('новий запит коду скасовує попередній доказ (доказ прив’язаний до останнього виклику)', async () => {
      const ctx = await open('gc2-newcode')
      const guest = guestFor(await issueCopy(ctx), 'gc2-newcode')
      const proof = await proofOf(guest)

      await sendCode(guest)

      const response = await answerWith(guest, proof, 'RECEIVED')

      expect(response.status).toBe(403)
      expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
    })

    it('захист від підбору: 5 хибних спроб гасять код; 10 за життя посилання закривають верифікацію до нової видачі', async () => {
      const ctx = await open('gc2-brute')
      const token = await issueCopy(ctx)
      const guest = guestFor(token, 'gc2-brute')
      const wrongOf = (code: string): string => (code === '123456' ? '654321' : '123456')

      // Перший код: 5 хибних гасять його — правильний уже не пройде.
      let code = await sendCode(guest)

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await pub('verify', { ...guest, code: wrongOf(code) })).status).toBe(400)
      }

      const burned = await pub('verify', { ...guest, code })

      expect(burned.status).toBe(400)
      expect(errorCode(burned.body)).toBe('GUEST_CODE_INVALID')

      // Другий код: ще 5 хибних — разом 10, ліміт посилання вичерпано.
      code = await sendCode(guest)

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await pub('verify', { ...guest, code: wrongOf(code) })).status).toBe(400)
      }

      expect((await rowOf(ctx.confirmation.id)).codeFailedTotal).toBe(10)

      // Далі — 429 і на верифікацію, і на новий код (навіть правильний код не допомагає).
      for (const [path, body] of [
        ['verify', { ...guest, code }],
        ['code', guest],
      ] as const) {
        const response = await pub(path, body)

        expect(response.status).toBe(429)
        expect(errorCode(response.body)).toBe('GUEST_CODE_RATE_LIMITED')
      }

      expect(await businessState(ctx).then((state) => state.status)).toBe('OPEN')

      // Нове посилання від власника відновлює доступ (лічильники нові).
      const fresh = { ...guest, token: await issueCopy(ctx) }

      await respond(fresh, 'RECEIVED')
    })

    it('паралельний перебір: 20 одночасних хибних спроб не перевищують ліміт і не підтверджують нічого', async () => {
      const ctx = await open('gc2-parallel')
      const guest = guestFor(await issueCopy(ctx), 'gc2-parallel')
      const code = await sendCode(guest)
      const wrong = code === '111111' ? '222222' : '111111'
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => pub('verify', { ...guest, code: wrong })),
      )

      expect(
        responses.every((response) => response.status === 400 || response.status === 429),
      ).toBe(true)

      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeFailedTotal).toBeLessThanOrEqual(10)
      expect(row.codeFailedTotal).toBe(5)
      expect(row.proofHash).toBeNull()
      expect((await pub('verify', { ...guest, code })).status).toBe(400)
    })

    it('ліміт листів із кодом: не більше 5 на посилання за годину (429), і в БД, а не лише в пам’яті процесу', async () => {
      const ctx = await open('gc2-sends')
      const guest = guestFor(await issueCopy(ctx), 'gc2-sends')

      for (let sent = 0; sent < 5; sent += 1) await pub('code', guest).expect(200)

      const limited = await pub('code', guest)

      expect(limited.status).toBe(429)
      expect(errorCode(limited.body)).toBe('GUEST_CODE_RATE_LIMITED')
      expect((await rowOf(ctx.confirmation.id)).codeSentCount).toBe(5)

      // Вікно минуло — знову можна.
      await prisma.guestLoanConfirmation.update({
        where: { id: ctx.confirmation.id },
        data: { codeWindowStartedAt: new Date(Date.now() - 61 * 60_000) },
      })
      await pub('code', guest).expect(200)
      expect((await rowOf(ctx.confirmation.id)).codeSentCount).toBe(1)
    })

    it('збій листа з кодом: 502, виклик гаситься; код не лишається чинним', async () => {
      const ctx = await open('gc2-codefail')
      const guest = guestFor(await issueCopy(ctx), 'gc2-codefail')

      jest.spyOn(mail, 'send').mockRejectedValueOnce(new Error('транспорт недоступний'))

      const response = await pub('code', guest)

      expect(response.status).toBe(502)
      expect(errorCode(response.body)).toBe('GUEST_LINK_EMAIL_FAILED')

      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeHash).toBeNull()
      expect(row.challengeMac).toBeNull()
    })

    it('код ніколи не повертається у відповідях і не потрапляє в БД/логи відкритим', async () => {
      const ctx = await open('gc2-secret')
      const guest = guestFor(await issueCopy(ctx), 'gc2-secret')
      const readLogs = captureLogs()
      const response = await pub('code', guest).expect(200)

      requestGuestCodeResponseSchema.parse(response.body)

      const code = codeFromLetter(guest.email)
      const row = await rowOf(ctx.confirmation.id)

      expect(JSON.stringify(response.body)).not.toContain(code)
      expect(JSON.stringify(response.body)).not.toContain(guest.email)
      expect(row.codeHash).not.toBe(code)
      expect(JSON.stringify(row)).not.toContain(guest.email)
      expect(JSON.stringify(row)).not.toContain(guest.nickname)
      expect(readLogs()).not.toContain(code)
      expect(readLogs()).not.toContain(guest.email)
    })

    it('валідація публічних тіл: реальний домен, порожній нікнейм, код не з шести цифр, невідома відповідь, зайві поля — 400', async () => {
      const ctx = await open('gc2-valid')
      const guest = guestFor(await issueCopy(ctx), 'gc2-valid')
      const before = await businessState(ctx)
      const bad: [string, object][] = [
        ['code', { ...guest, email: 'real@example.com' }],
        ['code', { ...guest, nickname: '   ' }],
        ['code', { ...guest, nickname: 'x'.repeat(61) }],
        ['code', { ...guest, extra: 1 }],
        ['verify', { ...guest, code: '12345' }],
        ['verify', { ...guest, code: 'abcdef' }],
        ['verify', guest],
        ['answer', { ...guest, proof: 'p', answer: 'MAYBE' }],
        ['answer', { ...guest, answer: 'RECEIVED' }],
        ['answer', { ...guest, proof: 'p', answer: 'RECEIVED', extra: 1 }],
      ]

      for (const [path, body] of bad) {
        const response = await pub(path, body)

        expect(response.status).toBe(400)
        expect(errorCode(response.body)).toBe('VALIDATION_ERROR')
      }

      expect(mail.sealedTo(guest.email)).toBeUndefined()
      expect(await businessState(ctx)).toEqual(before)
    })
  })

  // --- GC4/GC11: очікування і сплив -----------------------------------------------------------

  describe('GC4/GC11: очікування відповіді і сплив 7-денного посилання', () => {
    it('поки відповіді немає, Copy недоступний для нової позики, отримання не підтверджене, мовчання не стає «Отримав»', async () => {
      const ctx = await open('gc4-wait')

      await issueCopy(ctx)

      expect((await confirmationOf(ctx)).evidence).toBe('AWAITING_GUEST')
      expect(
        (
          await request(http()).post(url('/loans/guest')).set('Cookie', ctx.owner.cookie).send({
            copyId: ctx.shelf.copyId,
            externalBorrowerId: ctx.contactId,
            handedAt: '2026-01-02',
          })
        ).status,
      ).toBe(409)
      expect(
        (
          await request(http())
            .post(url('/guest-loan-confirmations'))
            .set('Cookie', ctx.owner.cookie)
            .send({
              copyId: ctx.shelf.copyId,
              externalBorrowerId: ctx.contactId,
              handedAt: '2026-01-02',
            })
        ).status,
      ).toBe(409)
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })).status,
      ).toBe('RESERVED')
    })

    it('сплив: посилання не діє (410 у всіх маршрутах), але Loan/Copy/запит не змінюються і нічого не підтверджується', async () => {
      const ctx = await open('gc11-expire')
      const guest = guestFor(await issueCopy(ctx), 'gc11')
      const proof = await proofOf(guest)
      const code = await sendCode(guest)

      // Спершу власне чинний доказ — сплив має його перебити.
      const readyProof = await proofOf(guest)

      await expireLink(ctx.confirmation.id)

      const before = await businessState(ctx)

      for (const [path, body] of [
        ['resolve', { token: guest.token }],
        ['code', guest],
        ['verify', { ...guest, code }],
        ['answer', { ...guest, proof: readyProof, answer: 'RECEIVED' }],
        ['answer', { ...guest, proof, answer: 'DENIED' }],
      ] as const) {
        const response = await pub(path, body)

        expect(response.status).toBe(410)
        expect(errorCode(response.body)).toBe('GUEST_LINK_EXPIRED')
      }

      expect(await businessState(ctx)).toEqual(before)
      expect(before.status).toBe('OPEN')
      expect(before.copy.status).toBe('RESERVED')
      expect(before.loans[0]?.status).toBe('PENDING_CONFIRMATION')
      expect(before.events.map((event) => event.type)).toEqual(['GUEST_CONFIRMATION_REQUESTED'])
      expect(before.contact.guestEmail).toBeNull()

      // Власник бачить сплив; запит лишається відкритим, DELETE контакту і CLI-чистка його не чіпають.
      const read = await confirmationOf(ctx)

      expect(read.link?.isExpired).toBe(true)
      expect(read.evidence).toBe('AWAITING_GUEST')
      expect(
        (await ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`)).status,
      ).toBe(409)

      await prisma.externalBorrower.update({
        where: { id: ctx.contactId },
        data: { retainUntil: new Date(Date.now() - DAY_MS) },
      })
      await cleanup.run(new Date())
      expect(
        await prisma.externalBorrower.findUnique({ where: { id: ctx.contactId } }),
      ).not.toBeNull()

      // Нове посилання: старе лишається мертвим, нове — чинне, гість відповідає.
      const fresh = { ...guest, token: await issueCopy(ctx) }

      // Старий токен після ротації — не «прострочений», а замінений: однакова відповідь із невідомим.
      expect((await pub('resolve', { token: guest.token })).status).toBe(404)
      await respond(fresh, 'RECEIVED')
      expect((await confirmationOf(ctx)).evidence).toBe('GUEST_CONFIRMED')
    })

    it('після спливу власник усе ще може закрити запит окремою дією (скасування чи запис зі слів)', async () => {
      const ctx = await open('gc11-owner')

      await issueCopy(ctx)
      await expireLink(ctx.confirmation.id)
      await ownerCall('patch', ctx.owner, `/guest-loan-confirmations/${ctx.confirmation.id}`)
        .send({ action: 'cancel_handover', bookIsWithOwner: true })
        .expect(200)

      const row = await rowOf(ctx.confirmation.id)

      expect(row.status).toBe('CANCELLED')
      expect(row.linkTokenHash).toBeNull()
      expect(
        (await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })).status,
      ).toBe('AVAILABLE')
    })

    it('рішення власника гасить посилання: після скасування чи запису відповісти за ним не можна', async () => {
      for (const action of [
        { action: 'cancel_handover', bookIsWithOwner: true },
        { action: 'record_owner_statement' },
      ]) {
        const ctx = await open(`gc11-dead-${action.action}`)
        const guest = guestFor(await issueCopy(ctx), 'gc11-dead')
        const proof = await proofOf(guest)

        await ownerCall('patch', ctx.owner, `/guest-loan-confirmations/${ctx.confirmation.id}`)
          .send(action)
          .expect(200)

        const response = await answerWith(guest, proof, 'RECEIVED')

        expect(response.status).toBe(404)
        expect(errorCode(response.body)).toBe('GUEST_LINK_INVALID')
        expect(await tablesContaining(guest.email)).toEqual([])
      }
    })
  })

  // --- GC8: D3, ручний DELETE, CLI ---------------------------------------------------------------

  describe('GC8: D3 і видалення контакту разом із підтвердженим email', () => {
    it('після «Отримав» → повернення: ручний DELETE видаляє контакт з B; Loan/LoanEvent/запит лишаються без B', async () => {
      const ctx = await open('gc8-delete')
      const guest = guestFor(await issueCopy(ctx), 'gc8-delete')

      await respond(guest, 'RECEIVED')
      expect(
        (await ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`)).status,
      ).toBe(409)
      await ownerCall('patch', ctx.owner, `/loans/guest/${ctx.confirmation.loan.id}`)
        .send({ action: 'return' })
        .expect(200)
      await ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`).expect(204)

      expect(await tablesContaining(guest.email)).toEqual([])
      expect(await tablesContaining(guest.nickname)).toEqual([])

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } })
      const row = await rowOf(ctx.confirmation.id)

      expect(loan).toMatchObject({ status: 'RETURNED', borrowerContactId: null })
      expect(row).toMatchObject({ status: 'RECEIVED', externalBorrowerId: null })
      expect(await eventTypes(loan.id)).toEqual([
        'GUEST_CONFIRMATION_REQUESTED',
        'GUEST_LOAN_RECEIVED',
        'LOAN_RETURNED',
      ])
    })

    it('CLI-чистка після повернення й строку D3 видаляє контакт з підтвердженим email; зв’язок не відновлюється', async () => {
      const ctx = await open('gc8-cli')
      const guest = guestFor(await issueCopy(ctx), 'gc8-cli')

      await respond(guest, 'RECEIVED')
      await ownerCall('patch', ctx.owner, `/loans/guest/${ctx.confirmation.loan.id}`)
        .send({ action: 'return' })
        .expect(200)

      const contact = await prisma.externalBorrower.findUniqueOrThrow({
        where: { id: ctx.contactId },
      })

      expect(contact.retainUntil?.getTime()).toBeGreaterThan(Date.now() + 89 * DAY_MS)

      // До строку контакт з B не чіпають.
      await cleanup.run(new Date())
      expect(
        (await prisma.externalBorrower.findUniqueOrThrow({ where: { id: ctx.contactId } }))
          .guestEmail,
      ).toBe(guest.email)

      await prisma.externalBorrower.update({
        where: { id: ctx.contactId },
        data: { retainUntil: new Date(Date.now() - 1000) },
      })
      await cleanup.run(new Date())

      expect(await prisma.externalBorrower.findUnique({ where: { id: ctx.contactId } })).toBeNull()
      expect(await tablesContaining(guest.email)).toEqual([])
      expect(await tablesContaining(guest.nickname)).toEqual([])
      expect(await rowOf(ctx.confirmation.id)).toMatchObject({
        status: 'RECEIVED',
        externalBorrowerId: null,
      })
      expect(
        (await prisma.loan.findUniqueOrThrow({ where: { id: ctx.confirmation.loan.id } }))
          .borrowerContactId,
      ).toBeNull()
    })

    it('«Не отримував» → скасування передачі: DELETE дозволено одразу і видаляє B; аудит заперечення лишається', async () => {
      const ctx = await open('gc8-denied')
      const guest = guestFor(await issueCopy(ctx), 'gc8-denied')

      await respond(guest, 'DENIED')
      expect(
        (await ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`)).status,
      ).toBe(409)
      await ownerCall('patch', ctx.owner, `/guest-loan-confirmations/${ctx.confirmation.id}`)
        .send({ action: 'cancel_handover', bookIsWithOwner: true })
        .expect(200)
      await ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`).expect(204)

      expect(await tablesContaining(guest.email)).toEqual([])
      expect(await eventTypes(ctx.confirmation.loan.id)).toContain('GUEST_LOAN_DENIED')

      const list = guestLoanConfirmationListResponseSchema.parse(
        (await ownerCall('get', ctx.owner, '/guest-loan-confirmations').expect(200)).body,
      )

      expect(list.confirmations.find((item) => item.id === ctx.confirmation.id)?.contact).toBeNull()
    })
  })

  // --- GC7: приватність ----------------------------------------------------------------------------

  describe('GC7: приватність адреси доставки, підтвердженої адреси і нікнейма', () => {
    it('другові, стороннім і в публічній історії немає A, B, нікнейма, alias, токена; власник бачить лише B і нікнейм', async () => {
      const owner = await registerAccount(app, 'gc7-owner')
      const friend = await registerAccount(app, 'gc7-friend')

      await befriend(app, owner, friend)

      const ctx = await open('gc7', owner)
      const a = synthetic('gc7-a')
      const b = synthetic('gc7-b')
      const nickname = `Приватний-${String(Date.now())}`

      await issue(owner, ctx.confirmation.id, { delivery: 'EMAIL', email: a }).expect(201)

      const token = tokenFromLetter(a)

      await respond({ token, nickname, email: b }, 'RECEIVED')

      const surfaces: string[] = []

      for (const path of [
        `/works/${ctx.shelf.workId}/history`,
        `/copies/${ctx.shelf.copyId}/history`,
        '/me/history',
        '/loans',
        '/loans/guest',
        '/me/library',
        '/notifications',
      ]) {
        const response = await request(http()).get(url(path)).set('Cookie', friend.cookie)

        surfaces.push(JSON.stringify(response.body))
      }

      for (const path of ['/works/' + ctx.shelf.workId + '/history', '/loans', '/notifications']) {
        surfaces.push(
          JSON.stringify((await request(http()).get(url(path)).set('Cookie', owner.cookie)).body),
        )
      }

      const combined = surfaces.join('\n')

      for (const hidden of [a, b, nickname, token, ctx.alias, ctx.contactId]) {
        // Друг не бачить нічого з приватного (у жодній публічній/спільній поверхні); тіла помилок теж.
        expect(combined).not.toContain(hidden)
      }

      // Власник бачить підтверджене лише в приватних ресурсах.
      const contacts = await ownerCall('get', owner, '/me/external-borrowers').expect(200)

      expect(JSON.stringify(contacts.body)).toContain(b)
      expect(JSON.stringify(contacts.body)).toContain(nickname)
      expect(JSON.stringify(contacts.body)).not.toContain(a)
      expect(await tablesContaining(a)).toEqual([])
      expect(await tablesContaining(b)).toEqual(['ExternalBorrower'])
      expect(await tablesContaining(nickname)).toEqual(['ExternalBorrower'])
    })

    it('відповіді помилок і тіла запитів не відлунюють введені адресу, нікнейм чи код', async () => {
      const ctx = await open('gc7-echo')
      const guest = guestFor(await issueCopy(ctx), 'gc7-echo')
      const readLogs = captureLogs()
      const responses = [
        await pub('code', { ...guest, email: 'real-person@example.com' }),
        await pub('verify', { ...guest, code: '123456' }),
        await pub('answer', { ...guest, proof: 'nope', answer: 'RECEIVED' }),
        await pub('verify', { ...guest, code: 'abcdef' }),
      ]

      for (const response of responses) {
        const text = JSON.stringify(response.body)

        for (const secret of [guest.email, guest.nickname, 'real-person@example.com', '123456']) {
          expect(text).not.toContain(secret)
        }
      }

      expect(readLogs()).not.toContain(guest.email)
      expect(readLogs()).not.toContain(guest.nickname)
      expect(readLogs()).not.toContain('real-person@example.com')
    })
  })

  // --- GC9: гонки ---------------------------------------------------------------------------------------

  describe('рев’ю 10i.2: збій відправки коду й час перевірки після локу', () => {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    /** Тримає `FOR UPDATE` на рядку підтвердження в окремому з'єднанні: запит гостя чекає на цьому локу. */
    async function holdConfirmationLock(
      id: string,
      whileHeld: (client: Client) => Promise<void>,
      beforeStart: () => Promise<request.Response>,
    ): Promise<request.Response> {
      const holder = new Client({ connectionString: testDatabaseUrl() })

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "GuestLoanConfirmation" WHERE "id" = $1 FOR UPDATE', [
          id,
        ])

        const pending = beforeStart()

        await waitForBlockedBackend(prisma, { expectedCount: 1 })
        await whileHeld(holder)
        await holder.query('COMMIT')

        return await pending
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    }

    const expireInMs = async (
      id: string,
      columns: 'link' | 'code' | 'proof',
      ms: number,
      holder: Client,
    ) => {
      const at = new Date(Date.now() + ms)

      if (columns === 'link') {
        await holder.query(
          `UPDATE "GuestLoanConfirmation" SET "linkExpiresAt" = $2::timestamp, "linkIssuedAt" = $2::timestamp - interval '7 days' WHERE id = $1`,
          [id, at.toISOString()],
        )
      } else {
        const column = columns === 'code' ? 'codeExpiresAt' : 'proofExpiresAt'

        await holder.query(
          `UPDATE "GuestLoanConfirmation" SET "${column}" = $2::timestamp WHERE id = $1`,
          [id, at.toISOString()],
        )
      }
    }

    it('дефект 1: збій відправки ПЕРШОГО коду не гасить код, виданий пізнішим паралельним запитом (ті самі email і nickname)', async () => {
      const ctx = await open('rev-fail-race')
      const guest = guestFor(await issueCopy(ctx), 'rev-fail-race')
      const original = mail.send.bind(mail)
      const entered = deferred()
      const release = deferred()
      let calls = 0

      jest.spyOn(mail, 'send').mockImplementation(async (message) => {
        calls += 1

        if (calls === 1) {
          entered.resolve()
          await release.promise

          throw new Error('транспорт недоступний')
        }

        return original(message)
      })

      const first = beginRequest(pub('code', guest))

      // Перший запит уже закомітив свій код і завис на відправці.
      await entered.promise

      await pub('code', guest).expect(200)

      const secondCode = codeFromLetter(guest.email)

      release.resolve()

      const failed = await first

      expect(failed.status).toBe(502)
      expect(errorCode(failed.body)).toBe('GUEST_LINK_EMAIL_FAILED')

      // Код другого запиту цілий і проходить verify.
      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeHash).not.toBeNull()
      await pub('verify', { ...guest, code: secondCode }).expect(200)
    })

    it('дефект 1 (повтор коду): однакові шість цифр для двох видач з тими самими email/nickname — збій першої не гасить другу, код і доказ чинні', async () => {
      const ctx = await open('rev-fail-same-code')
      const guest = guestFor(await issueCopy(ctx), 'rev-fail-same-code')
      const original = mail.send.bind(mail)
      const entered = deferred()
      const release = deferred()
      let calls = 0

      // Примусово однаковий код для обох видач: `codeHash` (HMAC від підтвердження, виклику й коду) збігається.
      jest.spyOn(app.get(GuestConfirmationSecrets), 'generateCode').mockReturnValue('123456')
      jest.spyOn(mail, 'send').mockImplementation(async (message) => {
        calls += 1

        if (calls === 1) {
          entered.resolve()
          await release.promise

          throw new Error('транспорт недоступний')
        }

        return original(message)
      })

      const first = beginRequest(pub('code', guest))

      await entered.promise

      const afterFirst = await rowOf(ctx.confirmation.id)

      await pub('code', guest).expect(200)

      const afterSecond = await rowOf(ctx.confirmation.id)

      // Той самий хеш (доводить, що codeHash не ідентифікує видачу), але різні nonce.
      expect(afterSecond.codeHash).toBe(afterFirst.codeHash)
      expect(afterSecond.codeNonce).not.toBe(afterFirst.codeNonce)
      expect(codeFromLetter(guest.email)).toBe('123456')

      release.resolve()

      const failed = await first

      expect(failed.status).toBe(502)
      expect(errorCode(failed.body)).toBe('GUEST_LINK_EMAIL_FAILED')

      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeHash).toBe(afterSecond.codeHash)
      expect(row.codeNonce).toBe(afterSecond.codeNonce)

      // Другий код і доказ лишаються чинними: verify проходить, з доказом можна відповісти.
      const proof = verifyGuestCodeResponseSchema.parse(
        (await pub('verify', { ...guest, code: '123456' }).expect(200)).body,
      ).proof

      await answerWith(guest, proof, 'RECEIVED').expect(200)
    })

    it('дефект 1 (пізній збій після verify): збій відправки не скасовує вже видданий доказ', async () => {
      const ctx = await open('rev-fail-after-verify')
      const guest = guestFor(await issueCopy(ctx), 'rev-fail-after-verify')
      const original = mail.send.bind(mail)
      const entered = deferred()
      const release = deferred()
      let calls = 0

      jest.spyOn(app.get(GuestConfirmationSecrets), 'generateCode').mockReturnValue('654321')
      jest.spyOn(mail, 'send').mockImplementation(async (message) => {
        calls += 1

        if (calls === 1) {
          entered.resolve()
          await release.promise

          throw new Error('транспорт недоступний')
        }

        return original(message)
      })

      const first = beginRequest(pub('code', guest))

      await entered.promise
      await pub('code', guest).expect(200)

      const proof = verifyGuestCodeResponseSchema.parse(
        (await pub('verify', { ...guest, code: '654321' }).expect(200)).body,
      ).proof

      release.resolve()
      expect((await first).status).toBe(502)

      const row = await rowOf(ctx.confirmation.id)

      expect(row.proofHash).not.toBeNull()
      await answerWith(guest, proof, 'DENIED').expect(200)
    })

    it('дефект 1 (без гонки): збій єдиної відправки все ще гасить свій власний код', async () => {
      const ctx = await open('rev-fail-own')
      const guest = guestFor(await issueCopy(ctx), 'rev-fail-own')

      jest.spyOn(mail, 'send').mockRejectedValueOnce(new Error('транспорт недоступний'))

      expect((await pub('code', guest)).status).toBe(502)

      const row = await rowOf(ctx.confirmation.id)

      expect(row.codeHash).toBeNull()
      expect(row.challengeMac).toBeNull()
    })

    it('дефект 2: посилання, що спливло під час очікування локу, не проходить у requestCode', async () => {
      const ctx = await open('rev-time-code')
      const guest = guestFor(await issueCopy(ctx), 'rev-time-code')
      const response = await holdConfirmationLock(
        ctx.confirmation.id,
        async (holder) => {
          await expireInMs(ctx.confirmation.id, 'link', 800, holder)
          await pause(1000)
        },
        () => beginRequest(pub('code', guest)),
      )

      expect(response.status).toBe(410)
      expect(errorCode(response.body)).toBe('GUEST_LINK_EXPIRED')
      expect(mail.sealedTo(guest.email)).toBeUndefined()
      expect((await rowOf(ctx.confirmation.id)).codeHash).toBeNull()
    })

    it('дефект 2: посилання, що спливло під час очікування, не проходить у verifyCode', async () => {
      const ctx = await open('rev-time-verify-link')
      const guest = guestFor(await issueCopy(ctx), 'rev-time-verify-link')
      const code = await sendCode(guest)
      const response = await holdConfirmationLock(
        ctx.confirmation.id,
        async (holder) => {
          await expireInMs(ctx.confirmation.id, 'link', 800, holder)
          await pause(1000)
        },
        () => beginRequest(pub('verify', { ...guest, code })),
      )

      expect(response.status).toBe(410)
      expect((await rowOf(ctx.confirmation.id)).proofHash).toBeNull()
    })

    it('дефект 2: код, що спливло під час очікування, не проходить у verifyCode', async () => {
      const ctx = await open('rev-time-verify-code')
      const guest = guestFor(await issueCopy(ctx), 'rev-time-verify-code')
      const code = await sendCode(guest)
      const response = await holdConfirmationLock(
        ctx.confirmation.id,
        async (holder) => {
          await expireInMs(ctx.confirmation.id, 'code', 800, holder)
          await pause(1000)
        },
        () => beginRequest(pub('verify', { ...guest, code })),
      )

      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('GUEST_CODE_INVALID')
      expect((await rowOf(ctx.confirmation.id)).proofHash).toBeNull()
    })

    it('дефект 2: доказ, що спливло під час очікування, не дає відповісти (answer)', async () => {
      const ctx = await open('rev-time-answer')
      const guest = guestFor(await issueCopy(ctx), 'rev-time-answer')
      const proof = await proofOf(guest)
      const response = await holdConfirmationLock(
        ctx.confirmation.id,
        async (holder) => {
          await expireInMs(ctx.confirmation.id, 'proof', 800, holder)
          await pause(1000)
        },
        () => beginRequest(answerWith(guest, proof, 'RECEIVED')),
      )

      expect(response.status).toBe(403)
      expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
    })

    it('дефект 2: момент видачі й 7-денний строк рахуються після локів, а не до очікування', async () => {
      const ctx = await open('rev-time-issue')
      const holder = new Client({ connectionString: testDatabaseUrl() })
      const startedAt = Date.now()

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "ExternalBorrower" WHERE "id" = $1 FOR UPDATE', [
          ctx.contactId,
        ])

        const issuing = beginRequest(issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }))

        await waitForBlockedBackend(prisma, { expectedCount: 1 })
        await pause(600)

        const releasedAt = Date.now()

        await holder.query('COMMIT')

        const response = await issuing

        expect(response.status).toBe(201)

        const row = await rowOf(ctx.confirmation.id)
        const issuedAt = row.linkIssuedAt?.getTime() ?? 0

        expect(releasedAt - startedAt).toBeGreaterThanOrEqual(600)
        expect(issuedAt).toBeGreaterThanOrEqual(releasedAt)
        expect((row.linkExpiresAt?.getTime() ?? 0) - issuedAt).toBe(7 * DAY_MS)
        expect(
          issueGuestConfirmationLinkResponseSchema.parse(response.body).confirmation.link?.issuedAt,
        ).toBe(row.linkIssuedAt?.toISOString())
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    })
  })

  describe('GC9: гонки відповіді гостя з іншими діями', () => {
    async function ready(prefix: string): Promise<{ ctx: Ctx; guest: Guest; proof: string }> {
      const ctx = await open(prefix)
      const guest = guestFor(await issueCopy(ctx), prefix)

      return { ctx, guest, proof: await proofOf(guest) }
    }

    it('«Отримав» ∥ «Не отримував» з одним доказом — рівно одна відповідь, стан узгоджений з переможцем', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ctx, guest, proof } = await ready(`gc9-answers-${String(round)}`)
        const [received, denied] = await Promise.all([
          answerWith(guest, proof, 'RECEIVED'),
          answerWith(guest, proof, 'DENIED'),
        ])
        const statuses = [received.status, denied.status].sort()

        expect(statuses).toEqual([200, 404])

        const row = await rowOf(ctx.confirmation.id)
        const loan = await prisma.loan.findUniqueOrThrow({
          where: { id: ctx.confirmation.loan.id },
        })
        const copy = await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })
        const types = await eventTypes(loan.id)

        if (received.status === 200) {
          expect(row.status).toBe('RECEIVED')
          expect([loan.status, copy.status]).toEqual(['HANDED_OVER', 'LENT_OUT'])
          expect(types).toEqual(['GUEST_CONFIRMATION_REQUESTED', 'GUEST_LOAN_RECEIVED'])
        } else {
          expect(row.status).toBe('DENIED')
          expect([loan.status, copy.status]).toEqual(['PENDING_CONFIRMATION', 'RESERVED'])
          expect(types).toEqual(['GUEST_CONFIRMATION_REQUESTED', 'GUEST_LOAN_DENIED'])
        }
      }
    })

    it('«Отримав» ∥ скасування передачі власником — одна дія виграє; ніколи HANDED_OVER без Copy=LENT_OUT чи навпаки', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ctx, guest, proof } = await ready(`gc9-cancel-${String(round)}`)
        const [answer, cancel] = await Promise.all([
          answerWith(guest, proof, 'RECEIVED'),
          ownerCall('patch', ctx.owner, `/guest-loan-confirmations/${ctx.confirmation.id}`).send({
            action: 'cancel_handover',
            bookIsWithOwner: true,
          }),
        ])
        const loan = await prisma.loan.findUniqueOrThrow({
          where: { id: ctx.confirmation.loan.id },
        })
        const copy = await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })

        if (answer.status === 200) {
          expect(cancel.status).toBe(409)
          expect([loan.status, copy.status]).toEqual(['HANDED_OVER', 'LENT_OUT'])
        } else {
          expect(answer.status).toBe(404)
          expect(cancel.status).toBe(200)
          expect([loan.status, copy.status]).toEqual(['CANCELLED', 'AVAILABLE'])
          expect((await rowOf(ctx.confirmation.id)).externalBorrowerId).toBe(ctx.contactId)
          expect(await tablesContaining(guest.email)).toEqual([])
        }
      }
    })

    it('«Отримав» ∥ запис зі слів власника — рівно один перехід у HANDED_OVER, джерело — переможець', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ctx, guest, proof } = await ready(`gc9-record-${String(round)}`)
        const [answer, record] = await Promise.all([
          answerWith(guest, proof, 'RECEIVED'),
          ownerCall('patch', ctx.owner, `/guest-loan-confirmations/${ctx.confirmation.id}`).send({
            action: 'record_owner_statement',
          }),
        ])

        if (answer.status === 200) {
          expect(record.status).toBe(409)
        } else {
          expect(answer.status).toBe(404)
          expect(record.status).toBe(200)
        }

        const read = await confirmationOf(ctx)

        expect(read.loan.status).toBe('HANDED_OVER')
        expect(read.evidence).toBe(answer.status === 200 ? 'GUEST_CONFIRMED' : 'OWNER_STATEMENT')
        expect(
          (await eventTypes(ctx.confirmation.loan.id)).filter((type) =>
            ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_OWNER_RECORDED'].includes(type),
          ),
        ).toHaveLength(1)
      }
    })

    it('«Отримав» ∥ ротація посилання — стара відповідь або встигла (тоді видача 409), або мертва (404)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ctx, guest, proof } = await ready(`gc9-rotate-${String(round)}`)
        const [answer, rotate] = await Promise.all([
          answerWith(guest, proof, 'RECEIVED'),
          issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }),
        ])
        const row = await rowOf(ctx.confirmation.id)

        if (answer.status === 200) {
          expect(rotate.status).toBe(409)
          expect(row.status).toBe('RECEIVED')
          expect(row.linkTokenHash).toBeNull()
        } else {
          expect(answer.status).toBe(404)
          expect(rotate.status).toBe(201)
          expect(row.status).toBe('OPEN')
          expect(row.linkTokenHash).not.toBeNull()
          expect((await businessState(ctx)).contact.guestEmail).toBeNull()
        }
      }
    })

    it('«Отримав» ∥ DELETE контакту — DELETE ніколи не проходить (позика активна), відповідь завжди успішна, без взаємоблокувань', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ctx, guest, proof } = await ready(`gc9-delete-${String(round)}`)
        const [answer, del] = await Promise.all([
          answerWith(guest, proof, 'RECEIVED'),
          ownerCall('delete', ctx.owner, `/me/external-borrowers/${ctx.contactId}`),
        ])

        expect(answer.status).toBe(200)
        expect(del.status).toBe(409)
        expect(errorCode(del.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')
        expect(
          (await prisma.externalBorrower.findUniqueOrThrow({ where: { id: ctx.contactId } }))
            .guestEmail,
        ).toBe(guest.email)
      }
    })

    it('«Отримав» ∥ CLI-чистка з примусово простроченим retainUntil — контакт не видаляється, підтвердження записано', async () => {
      const { ctx, guest, proof } = await ready('gc9-cli')

      await prisma.externalBorrower.update({
        where: { id: ctx.contactId },
        data: { retainUntil: new Date(Date.now() - DAY_MS) },
      })

      const [answer] = await Promise.all([
        answerWith(guest, proof, 'RECEIVED'),
        cleanup.run(new Date()),
      ])

      expect(answer.status).toBe(200)

      const contact = await prisma.externalBorrower.findUnique({ where: { id: ctx.contactId } })

      expect(contact?.guestEmail).toBe(guest.email)
      expect(contact?.retainUntil).toBeNull()
    })

    it('deferred: відповідь, заблокована на локу ExternalBorrower, чекає й завершується (порядок EB → Copy → Loan → GuestLoanConfirmation)', async () => {
      const { ctx, guest, proof } = await ready('gc9-lock')
      const holder = new Client({ connectionString: testDatabaseUrl() })

      await holder.connect()

      try {
        await holder.query('BEGIN')
        await holder.query('SELECT "id" FROM "ExternalBorrower" WHERE "id" = $1 FOR UPDATE', [
          ctx.contactId,
        ])

        const answering = beginRequest(answerWith(guest, proof, 'RECEIVED'))

        await waitForBlockedBackend(prisma, { expectedCount: 1 })

        // Поки перший ресурс порядку зайнятий, нічого нижче не заторкнуто.
        expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
        expect(
          (await prisma.copy.findUniqueOrThrow({ where: { id: ctx.shelf.copyId } })).status,
        ).toBe('RESERVED')

        await holder.query('COMMIT')

        expect((await answering).status).toBe(200)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end()
      }
    })

    it('дві одночасні видачі посилання — обидві успішні послідовно, чинним лишається рівно одне', async () => {
      const ctx = await open('gc9-double-issue')
      const [one, two] = await Promise.all([
        issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }),
        issue(ctx.owner, ctx.confirmation.id, { delivery: 'COPY' }),
      ])

      expect([one.status, two.status]).toEqual([201, 201])

      const tokens = [one, two].map((response) =>
        tokenOfUrl(issueGuestConfirmationLinkResponseSchema.parse(response.body).url),
      )
      const alive: string[] = []

      for (const token of tokens) {
        if ((await pub('resolve', { token })).status === 200) alive.push(token)
      }

      expect(alive).toHaveLength(1)
      expect((await rowOf(ctx.confirmation.id)).linkTokenHash).toBe(sha256(alive[0] ?? ''))
    })
  })

  // --- Обмеження частоти (throttler) --------------------------------------------------------------------

  describe('обмеження частоти публічних маршрутів (throttler)', () => {
    it('після вичерпання ліміту — 429; ліміт налаштовується й обмежує саме гостьові маршрути', async () => {
      const limited = await createTestApp({ withRateLimit: true })
      const previous = {
        rate: process.env.GUEST_RESPONSE_RATE_LIMIT,
        code: process.env.GUEST_CODE_SEND_RATE_LIMIT,
      }

      process.env.GUEST_RESPONSE_RATE_LIMIT = '3'
      process.env.GUEST_CODE_SEND_RATE_LIMIT = '2'

      try {
        const call = (path: string, body: object): request.Test =>
          request(limited.getHttpServer())
            .post(url(`/guest-loan-responses/${path}`))
            .send(body)
        const statuses: number[] = []

        for (let i = 0; i < 5; i += 1) statuses.push((await call('resolve', { token: 'x' })).status)

        expect(statuses).toEqual([404, 404, 404, 429, 429])

        const codeStatuses: number[] = []
        const body = { token: 'x', nickname: 'Н', email: synthetic('rl') }

        for (let i = 0; i < 4; i += 1) codeStatuses.push((await call('code', body)).status)

        expect(codeStatuses).toEqual([404, 404, 429, 429])
      } finally {
        for (const [key, value] of [
          ['GUEST_RESPONSE_RATE_LIMIT', previous.rate],
          ['GUEST_CODE_SEND_RATE_LIMIT', previous.code],
        ] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }

        await limited.close()
      }
    })
  })

  // --- Сумісність з 10f.3 / 10g / 10i.1 ------------------------------------------------------------------

  describe('не ламає попередні шляхи', () => {
    it('ручний запис 10f.3 працює як раніше: HANDED_OVER одразу, без рядка підтвердження і посилання', async () => {
      const owner = await registerAccount(app, 'gc6-legacy')
      const shelf = await createShelfCopy(app, owner)
      const contactId = await createContact(owner, 'Гість legacy 10i2')
      const created = await ownerCall('post', owner, '/loans/guest')
        .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
        .expect(201)
      const loanId = (created.body as { loan: { id: string } }).loan.id

      expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe(
        'HANDED_OVER',
      )
      expect(await prisma.guestLoanConfirmation.count({ where: { loanId } })).toBe(0)
      expect(await eventTypes(loanId)).toEqual(['GUEST_LOAN_RECORDED'])
      // Для позики без запиту посилання не видається.
      const list = guestLoanConfirmationListResponseSchema.parse(
        (await ownerCall('get', owner, '/guest-loan-confirmations').expect(200)).body,
      )

      expect(list.confirmations.filter((item) => item.loan.id === loanId)).toEqual([])
    })

    it('запрошення 10g не підтверджує позику: лист-запрошення не зберігає адресу і не має нічого спільного з підтвердженням', async () => {
      const owner = await registerAccount(app, 'gc6-invite')

      await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } })

      const ctx = await open('gc6-invite', owner)
      const invitee = synthetic('gc6-invitee')
      const token = await issueCopy(ctx)

      await ownerCall('post', owner, `/me/external-borrowers/${ctx.contactId}/invitation`)
        .send({ email: invitee })
        .expect(201)

      // Адреса запрошення на відповідь ніяк не впливає; запит лишається відкритим.
      expect((await rowOf(ctx.confirmation.id)).status).toBe('OPEN')
      expect((await pub('resolve', { token })).status).toBe(200)
      expect(await tablesContaining(invitee)).toEqual([])
    })
  })
})
