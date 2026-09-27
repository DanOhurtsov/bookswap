import './helpers/guest-loans-off'
import 'reflect-metadata'
import request from 'supertest'
import { apiErrorSchema, sessionResponseSchema } from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { registerAccount, url, type Account } from './loan.helpers'
import { SessionService } from '../src/auth/session.service'
import { ExternalBorrowersService } from '../src/external-borrowers/external-borrowers.service'
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

  const routes: [string, 'post' | 'get' | 'patch', string, object | undefined][] = [
    ['POST', 'post', '/me/external-borrowers', { alias: 'Гість', ownerInformed: true }],
    ['GET', 'get', '/me/external-borrowers', undefined],
    ['PATCH', 'patch', '/me/external-borrowers/any-id', { alias: 'Нове' }],
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
      ]
      const model = prisma.externalBorrower
      const dbSpies = [
        jest.spyOn(model, 'create'),
        jest.spyOn(model, 'findMany'),
        jest.spyOn(model, 'findFirst'),
        jest.spyOn(model, 'updateMany'),
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
