import './helpers/guest-loans-on'
import 'reflect-metadata'
import request from 'supertest'
import {
  apiErrorSchema,
  externalBorrowerListResponseSchema,
  externalBorrowerResponseSchema,
  sessionResponseSchema,
} from '@bookswap/shared'
import { createTestApp, VALID_PASSWORD, sessionCookie, uniqueEmail } from './auth.helpers'
import {
  befriend,
  createShelfCopy,
  registerAccount,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, 10f.2 (GL2, GL3, GATE1, P2, P3): приватні контакти `ExternalBorrower`.
 * Лише синтетичні дані; D2 лишається відкритим.
 */
describe('Stage 10 (10f.2): приватні контакти (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const http = (): App => app.getHttpServer()
  const errorCode = (body: unknown): string => apiErrorSchema.parse(body).code

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

  describe('сесія', () => {
    it.each([
      ['post', '/me/external-borrowers', { alias: 'Гість', ownerInformed: true }],
      ['get', '/me/external-borrowers', undefined],
      ['patch', '/me/external-borrowers/x', { alias: 'Гість' }],
    ] as const)('без сесії %s → 401 UNAUTHORIZED', async (method, path, body) => {
      const call = request(http())[method](url(path))
      const response = await (body === undefined ? call : call.send(body))

      expect(response.status).toBe(401)
      expect(errorCode(response.body)).toBe('UNAUTHORIZED')
    })

    it('register, login і GET /auth/session віддають guestLoans=true', async () => {
      const email = uniqueEmail('r10f2-on')
      const registered = await request(http())
        .post(url('/auth/register'))
        .send({ email, password: VALID_PASSWORD, displayName: 'Синтетичний' })
        .expect(201)
      const login = await request(http())
        .post(url('/auth/login'))
        .send({ email, password: VALID_PASSWORD })
        .expect(200)
      const cookie = sessionCookie(login.headers)
      const session = await request(http())
        .get(url('/auth/session'))
        .set('Cookie', cookie)
        .expect(200)

      for (const response of [registered, login, session]) {
        expect(sessionResponseSchema.parse(response.body).features).toEqual({ guestLoans: true })
      }
    })
  })

  describe('створення', () => {
    it('201: ownerId із сесії, ownerInformedAt від сервера, retainUntil порожній, alias обрізано', async () => {
      const owner = await registerAccount(app, 'r10f2-create')
      const before = Date.now()
      const response = await request(http())
        .post(url('/me/external-borrowers'))
        .set('Cookie', owner.cookie)
        .send({ alias: '  Тестовий Гість  ', ownerInformed: true })
        .expect(201)
      const { contact } = externalBorrowerResponseSchema.parse(response.body)

      expect(contact.alias).toBe('Тестовий Гість')
      expect(Object.keys(contact).sort()).toEqual(['alias', 'createdAt', 'id', 'ownerInformedAt'])
      expect(Date.parse(contact.ownerInformedAt ?? '')).toBeGreaterThanOrEqual(before - 1000)
      expect(Date.parse(contact.ownerInformedAt ?? '')).toBeLessThanOrEqual(Date.now() + 1000)

      const row = await prisma.externalBorrower.findUniqueOrThrow({ where: { id: contact.id } })

      expect(row.ownerId).toBe(owner.id)
      expect(row.retainUntil).toBeNull()
      expect(row.ownerInformedAt).not.toBeNull()
    })

    it.each([
      ['порожній alias', { alias: '', ownerInformed: true }],
      ['alias із пробілів', { alias: '   ', ownerInformed: true }],
      ['без alias', { ownerInformed: true }],
      ['ownerInformed=false', { alias: 'Гість', ownerInformed: false }],
      ['без ownerInformed', { alias: 'Гість' }],
      ['ownerId від клієнта', { alias: 'Гість', ownerInformed: true, ownerId: 'someone' }],
      [
        'ownerInformedAt від клієнта',
        { alias: 'Гість', ownerInformed: true, ownerInformedAt: '2020-01-01T00:00:00.000Z' },
      ],
      [
        'retainUntil від клієнта',
        { alias: 'Гість', ownerInformed: true, retainUntil: '2099-01-01T00:00:00.000Z' },
      ],
      ['email', { alias: 'Гість', ownerInformed: true, email: 'guest@example.com' }],
      ['нотатки', { alias: 'Гість', ownerInformed: true, note: 'x' }],
      ['майбутня прив’язка', { alias: 'Гість', ownerInformed: true, linkedUserId: 'u' }],
    ])('400 VALIDATION_ERROR і жодного запису: %s', async (_name, body) => {
      const owner = await registerAccount(app, 'r10f2-invalid')
      const response = await request(http())
        .post(url('/me/external-borrowers'))
        .set('Cookie', owner.cookie)
        .send(body)

      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('VALIDATION_ERROR')
      expect(await prisma.externalBorrower.count({ where: { ownerId: owner.id } })).toBe(0)
    })
  })

  describe('список і редагування', () => {
    it('власник бачить лише свої контакти, новіші першими', async () => {
      const owner = await registerAccount(app, 'r10f2-list')
      const other = await registerAccount(app, 'r10f2-list-other')

      await createContact(owner, 'Перший')
      await createContact(other, 'Чужий')
      await createContact(owner, 'Другий')

      const response = await request(http())
        .get(url('/me/external-borrowers'))
        .set('Cookie', owner.cookie)
        .expect(200)
      const { contacts } = externalBorrowerListResponseSchema.parse(response.body)

      expect(contacts.map((contact) => contact.alias)).toEqual(['Другий', 'Перший'])
    })

    it('PATCH змінює лише alias і не чіпає ownerInformedAt/retainUntil/ownerId', async () => {
      const owner = await registerAccount(app, 'r10f2-patch')
      const id = await createContact(owner, 'Старий')
      const before = await prisma.externalBorrower.findUniqueOrThrow({ where: { id } })
      const response = await request(http())
        .patch(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .send({ alias: '  Новий ' })
        .expect(200)

      expect(externalBorrowerResponseSchema.parse(response.body).contact.alias).toBe('Новий')

      const after = await prisma.externalBorrower.findUniqueOrThrow({ where: { id } })

      expect(after).toEqual({ ...before, alias: 'Новий' })
    })

    it.each([
      ['порожній alias', { alias: '' }],
      ['без полів', {}],
      ['ownerInformed', { alias: 'Н', ownerInformed: true }],
      ['ownerInformedAt', { alias: 'Н', ownerInformedAt: '2020-01-01T00:00:00.000Z' }],
      ['retainUntil', { alias: 'Н', retainUntil: null }],
      ['ownerId', { alias: 'Н', ownerId: 'someone' }],
      ['email', { alias: 'Н', email: 'a@b.c' }],
    ])('PATCH 400 і без змін: %s', async (_name, body) => {
      const owner = await registerAccount(app, 'r10f2-patch-bad')
      const id = await createContact(owner, 'Незмінний')
      const response = await request(http())
        .patch(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .send(body)

      expect(response.status).toBe(400)
      expect((await prisma.externalBorrower.findUniqueOrThrow({ where: { id } })).alias).toBe(
        'Незмінний',
      )
    })

    it('чужий і відсутній контакт нерозрізненні: 404 NOT_FOUND, чужий alias не змінюється', async () => {
      const owner = await registerAccount(app, 'r10f2-own')
      const stranger = await registerAccount(app, 'r10f2-stranger')
      const id = await createContact(owner, 'Приватний')
      const foreign = await request(http())
        .patch(url(`/me/external-borrowers/${id}`))
        .set('Cookie', stranger.cookie)
        .send({ alias: 'Захоплений' })
      const missing = await request(http())
        .patch(url('/me/external-borrowers/does-not-exist'))
        .set('Cookie', stranger.cookie)
        .send({ alias: 'Захоплений' })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(errorCode(foreign.body)).toBe('NOT_FOUND')
      expect(foreign.body).toEqual(missing.body)
      expect((await prisma.externalBorrower.findUniqueOrThrow({ where: { id } })).alias).toBe(
        'Приватний',
      )
    })
  })

  describe('приватність', () => {
    const ALIAS = 'Синтетичний-Унікальний-Аліас-10f2'

    it('друг і сторонній не бачать контактів; alias відсутній у побічних каналах і логах', async () => {
      const owner = await registerAccount(app, 'r10f2-priv-owner')
      const friend = await registerAccount(app, 'r10f2-priv-friend')
      const stranger = await registerAccount(app, 'r10f2-priv-stranger')

      await befriend(app, owner, friend)

      const written: string[] = []
      const capture = (chunk: unknown): boolean => {
        written.push(typeof chunk === 'string' ? chunk : String(chunk))

        return true
      }
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture)
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture)

      try {
        const id = await createContact(owner, ALIAS)

        await request(http())
          .get(url('/me/external-borrowers'))
          .set('Cookie', owner.cookie)
          .expect(200)
        await request(http())
          .patch(url(`/me/external-borrowers/${id}`))
          .set('Cookie', owner.cookie)
          .send({ alias: `${ALIAS}-2` })
          .expect(200)
        await request(http())
          .post(url('/me/external-borrowers'))
          .set('Cookie', owner.cookie)
          .send({ alias: ALIAS, ownerInformed: false })
          .expect(400)
        await request(http())
          .patch(url(`/me/external-borrowers/${id}`))
          .set('Cookie', stranger.cookie)
          .send({ alias: ALIAS })
          .expect(404)
      } finally {
        stdout.mockRestore()
        stderr.mockRestore()
      }

      expect(written.join('')).not.toContain('Аліас-10f2')

      for (const viewer of [friend, stranger]) {
        const own = await request(http())
          .get(url('/me/external-borrowers'))
          .set('Cookie', viewer.cookie)
          .expect(200)

        expect(externalBorrowerListResponseSchema.parse(own.body).contacts).toEqual([])

        for (const path of [
          '/me',
          '/friends',
          '/friends/requests',
          '/me/library',
          '/me/library/out',
          '/me/library/borrowed',
          '/me/history',
          '/loans',
          '/me/notifications',
          `/users?q=r10f2`,
          `/users/${owner.id}/library`,
        ]) {
          const response = await request(http()).get(url(path)).set('Cookie', viewer.cookie)

          expect({ path, leaked: JSON.stringify(response.body).includes('Аліас-10f2') }).toEqual({
            path,
            leaked: false,
          })
        }
      }

      const notifications = await prisma.notification.findMany({
        where: { userId: { in: [owner.id, friend.id, stranger.id] } },
      })
      const events = await prisma.productEvent.findMany()

      expect(JSON.stringify(notifications)).not.toContain('Аліас-10f2')
      expect(JSON.stringify(events)).not.toContain('Аліас-10f2')
    })
  })

  /**
   * Stage 10 (10f.3, Q3d, §6.4/§6.11.2 execution plan): дострокова чистка `DELETE`. Розширена
   * передумова — «немає активної позики (`EXCLUSIVE_LOAN_STATUS`) і немає незакритої `LOST`».
   */
  describe('видалення (DELETE, Q3d)', () => {
    async function guestLoan(owner: Account, shelf: Shelf, contactId: string): Promise<string> {
      const response = await request(http())
        .post(url('/loans/guest'))
        .set('Cookie', owner.cookie)
        .send({ copyId: shelf.copyId, externalBorrowerId: contactId, handedAt: '2026-01-01' })
        .expect(201)

      return (response.body as { loan: { id: string } }).loan.id
    }

    const act = (owner: Account, loanId: string, action: string): request.Test =>
      request(http())
        .patch(url(`/loans/guest/${loanId}`))
        .set('Cookie', owner.cookie)
        .send({ action })

    it('чужий і відсутній контакт — однаково 404, нічого не видалено', async () => {
      const owner = await registerAccount(app, 'r10f3-del-own')
      const stranger = await registerAccount(app, 'r10f3-del-stranger')
      const id = await createContact(owner, 'Контакт для DEL')

      const foreign = await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', stranger.cookie)
      const missing = await request(http())
        .delete(url('/me/external-borrowers/does-not-exist'))
        .set('Cookie', stranger.cookie)

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(errorCode(foreign.body)).toBe('NOT_FOUND')
      expect(foreign.body).toEqual(missing.body)
      expect(await prisma.externalBorrower.count({ where: { id } })).toBe(1)
    })

    it('без жодної позики — дозволено, 204', async () => {
      const owner = await registerAccount(app, 'r10f3-del-empty')
      const id = await createContact(owner, 'Контакт без позик')

      await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      expect(await prisma.externalBorrower.count({ where: { id } })).toBe(0)
    })

    it('активна гостьова позика (HANDED_OVER) → 409 EXTERNAL_BORROWER_HAS_ACTIVE_LOAN', async () => {
      const owner = await registerAccount(app, 'r10f3-del-active')
      const shelf = await createShelfCopy(app, owner)
      const id = await createContact(owner, 'Контакт з активною позикою')

      await guestLoan(owner, shelf, id)

      const response = await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)

      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('EXTERNAL_BORROWER_HAS_ACTIVE_LOAN')
      expect(await prisma.externalBorrower.count({ where: { id } })).toBe(1)
    })

    it('незакрита LOST → 409 EXTERNAL_BORROWER_HAS_UNRESOLVED_LOSS; після recover — дозволено', async () => {
      const owner = await registerAccount(app, 'r10f3-del-lost')
      const shelf = await createShelfCopy(app, owner)
      const id = await createContact(owner, 'Контакт з незакритою втратою')
      const loanId = await guestLoan(owner, shelf, id)

      await act(owner, loanId, 'mark_lost').expect(200)

      const blocked = await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)

      expect(blocked.status).toBe(409)
      expect(errorCode(blocked.body)).toBe('EXTERNAL_BORROWER_HAS_UNRESOLVED_LOSS')

      await act(owner, loanId, 'recover').expect(200)

      await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .expect(204)
    })

    it('незакрита LOST, закрита через close_loss — теж дозволяє DELETE', async () => {
      const owner = await registerAccount(app, 'r10f3-del-closed')
      const shelf = await createShelfCopy(app, owner)
      const id = await createContact(owner, 'Контакт, закритий через close_loss')
      const loanId = await guestLoan(owner, shelf, id)

      await act(owner, loanId, 'mark_lost').expect(200)
      await act(owner, loanId, 'close_loss').expect(200)

      await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .expect(204)
    })

    it('RETURNED (закрита звичайним поверненням) — дозволяє DELETE', async () => {
      const owner = await registerAccount(app, 'r10f3-del-returned')
      const shelf = await createShelfCopy(app, owner)
      const id = await createContact(owner, 'Контакт, книжку повернуто')
      const loanId = await guestLoan(owner, shelf, id)

      await act(owner, loanId, 'return').expect(200)

      await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .expect(204)
    })

    it('після DELETE Loan/LoanEvent зберігаються без контакту; retainUntil не читається', async () => {
      const owner = await registerAccount(app, 'r10f3-del-preserve')
      const shelf = await createShelfCopy(app, owner)
      const id = await createContact(owner, 'Контакт, факти зберігаються')
      const loanId = await guestLoan(owner, shelf, id)

      await act(owner, loanId, 'return').expect(200)
      await request(http())
        .delete(url(`/me/external-borrowers/${id}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.borrowerContactId).toBeNull()
      expect(loan.borrowerKind).toBe('GUEST')
      expect(loan.status).toBe('RETURNED')
      expect(await prisma.loanEvent.count({ where: { loanId } })).toBeGreaterThan(0)
    })
  })
})
