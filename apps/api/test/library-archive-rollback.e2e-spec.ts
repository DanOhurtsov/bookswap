import 'reflect-metadata'
import request from 'supertest'
import { createTestApp } from './auth.helpers'
import { befriend, createShelfCopy, registerAccount, requestLoan, url } from './loan.helpers'
import { NotificationsService } from '../src/notifications/notifications.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, 10c, A3: архівування й відхилення відкритих `REQUESTED` — одна транзакція. Це видно лише
 * зламавши запис сповіщення (як `loans-rollback.e2e-spec.ts`): жодних слідів — ні `archivedAt`, ні `REJECTED`.
 */
describe('Атомарність архівування (e2e, 10c)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let failNotifications = false

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(NotificationsService).useValue({
          create: () =>
            failNotifications
              ? Promise.reject(new Error('Симульований збій запису сповіщення'))
              : Promise.resolve(),
          dispatchSoon: () => undefined,
        })
      },
    })
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  it('падіння на сповіщенні лишає REQUESTED і не архівує примірник', async () => {
    const owner = await registerAccount(app, 'arch-rb-owner')
    const borrower = await registerAccount(app, 'arch-rb-borrower')

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const created = await requestLoan(app, borrower, shelf.copyId).expect(201)
    const loanId = (created.body as { loan: { id: string } }).loan.id

    failNotifications = true

    try {
      await request(app.getHttpServer())
        .post(url(`/me/library/${shelf.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(500)
    } finally {
      failNotifications = false
    }

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

    expect(loan.status).toBe('REQUESTED')
    expect(loan.respondedAt).toBeNull()
    expect(
      (await prisma.copy.findUniqueOrThrow({ where: { id: shelf.copyId } })).archivedAt,
    ).toBeNull()
  })
})
