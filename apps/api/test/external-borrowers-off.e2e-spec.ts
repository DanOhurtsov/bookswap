import './helpers/guest-loans-off'
import 'reflect-metadata'
import request from 'supertest'
import { apiErrorSchema, sessionResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { registerAccount, url, type Account } from './loan.helpers'
import { SessionService } from '../src/auth/session.service'
import { ExternalBorrowersService } from '../src/external-borrowers/external-borrowers.service'
import { GuestLoanService } from '../src/loans/guest-loan.service'
import { LoanService } from '../src/loans/loan.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/** Stage 10, 10f.2 (GATE1, T9): прапор вимкнено — контактні маршрути закриті до сесії, handler'а й БД. */
describe('Stage 10 (10f.2): контакти при вимкненому прапорі (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 'r10f2-off')
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const routes: [string, 'post' | 'get' | 'patch' | 'delete', string, object | undefined][] = [
    ['POST', 'post', '/me/external-borrowers', { alias: 'Гість', ownerInformed: true }],
    ['GET', 'get', '/me/external-borrowers', undefined],
    ['PATCH', 'patch', '/me/external-borrowers/any-id', { alias: 'Нове' }],
    ['DELETE', 'delete', '/me/external-borrowers/any-id', undefined],
  ]

  it.each(routes)(
    '%s → 403 FEATURE_DISABLED, session/service/DB не викликаються (і з сесією, і без)',
    async (_name, method, path, body) => {
      const validate = jest.spyOn(app.get(SessionService), 'validate')
      const service = app.get(ExternalBorrowersService)
      const spies = [
        jest.spyOn(service, 'create'),
        jest.spyOn(service, 'list'),
        jest.spyOn(service, 'updateAlias'),
        jest.spyOn(service, 'delete'),
      ]
      const model = prisma.externalBorrower
      const dbSpies = [
        jest.spyOn(model, 'create'),
        jest.spyOn(model, 'findMany'),
        jest.spyOn(model, 'findFirst'),
        jest.spyOn(model, 'updateMany'),
        jest.spyOn(model, 'delete'),
      ]

      for (const cookie of [owner.cookie, undefined]) {
        const base = request(http())[method](url(path))
        const call = cookie === undefined ? base : base.set('Cookie', cookie)
        const response = await (body === undefined ? call : call.send(body))

        expect(response.status).toBe(403)
        expect(apiErrorSchema.parse(response.body).code).toBe('FEATURE_DISABLED')
      }

      expect(validate).not.toHaveBeenCalled()
      for (const spy of [...spies, ...dbSpies]) expect(spy).not.toHaveBeenCalled()
      expect(await prisma.externalBorrower.count({ where: { ownerId: owner.id } })).toBe(0)

      // Sanity: the spies really see calls made through the same client.
      await prisma.externalBorrower.findMany({ take: 1 })
      expect(dbSpies[1]).toHaveBeenCalledTimes(1)
    },
  )

  /**
   * Stage 10 (10f.3, GATE1): гостьові маршрути позик — окремий контролер (`GuestLoansController`),
   * та сама вимога: `403` до сесії, сервісу й БД.
   */
  const guestLoanRoutes: [string, 'post' | 'get' | 'patch', string, object | undefined][] = [
    [
      'POST',
      'post',
      '/loans/guest',
      { copyId: 'x', externalBorrowerId: 'y', handedAt: '2026-01-01' },
    ],
    ['GET', 'get', '/loans/guest', undefined],
    ['GET', 'get', '/loans/guest/any-id', undefined],
    ['PATCH', 'patch', '/loans/guest/any-id', { action: 'return' }],
  ]

  it.each(guestLoanRoutes)(
    '%s /loans/guest[...] → 403 FEATURE_DISABLED, session/service/БД не викликаються',
    async (_name, method, path, body) => {
      const validate = jest.spyOn(app.get(SessionService), 'validate')
      const service = app.get(GuestLoanService)
      const spies = [
        jest.spyOn(service, 'create'),
        jest.spyOn(service, 'list'),
        jest.spyOn(service, 'get'),
        jest.spyOn(service, 'apply'),
      ]
      const dbSpy = jest.spyOn(prisma.loan, 'findMany')
      // Item 5 (рев'ю): пряме підтвердження відсутності конфлікту `GET /loans/guest` (статичний
      // сегмент) із `GET /loans/:id` (параметр, `LoansController`, той самий рівень вкладеності).
      // Якби Express колись почав матчити їх у зворотному порядку, цей шпигун упіймав би виклик
      // `LoanService.get(userId, 'guest')` — 200/404 замість 403 сам собою це довести не міг би,
      // бо `LoanService.get` теж дав би 404 на самоті, легко сплутати з правильною відмовою.
      const registeredGetSpy = jest.spyOn(app.get(LoanService), 'get')

      for (const cookie of [owner.cookie, undefined]) {
        const base = request(http())[method](url(path))
        const call = cookie === undefined ? base : base.set('Cookie', cookie)
        const response = await (body === undefined ? call : call.send(body))

        expect(response.status).toBe(403)
        expect(apiErrorSchema.parse(response.body).code).toBe('FEATURE_DISABLED')
      }

      expect(validate).not.toHaveBeenCalled()
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      expect(dbSpy).not.toHaveBeenCalled()
      expect(registeredGetSpy).not.toHaveBeenCalled()
      expect(await prisma.externalBorrower.count({ where: { ownerId: owner.id } })).toBe(0)
      expect(await prisma.loan.count({ where: { ownerId: owner.id, borrowerKind: 'GUEST' } })).toBe(
        0,
      )
    },
  )

  it('невалідне тіло теж не доходить до валідації: 403, а не 400', async () => {
    const response = await request(http())
      .post(url('/me/external-borrowers'))
      .set('Cookie', owner.cookie)
      .send({ alias: '', ownerInformed: false, ownerId: 'x' })

    expect(response.status).toBe(403)
  })

  it('GET /auth/session віддає guestLoans=false', async () => {
    const response = await request(http())
      .get(url('/auth/session'))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(sessionResponseSchema.parse(response.body).features).toEqual({ guestLoans: false })
  })
})
