import 'reflect-metadata'
import request from 'supertest'
import { createTestApp } from './auth.helpers'
import { befriend, createShelfCopy, registerAccount, requestLoan, url } from './loan.helpers'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, 10c: архівування відхиляє лише справжні request-flow `REQUESTED`. Записана власником
 * позика (`origin = RECORDED_EXISTING`), навіть зі статусом `REQUESTED`, не змінюється й не отримує `LOAN_REJECTED`.
 */
describe('Архівування й записані позики (e2e, 10c)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  it('REQUESTED з origin=RECORDED_EXISTING не відхиляється й без сповіщення; справжній запит відхиляється', async () => {
    const owner = await registerAccount(app, 's10c-owner')
    const friend = await registerAccount(app, 's10c-friend')
    const other = await registerAccount(app, 's10c-other')

    await befriend(app, owner, friend)
    await befriend(app, owner, other)

    const shelf = await createShelfCopy(app, owner)
    const real = await requestLoan(app, other, shelf.copyId).expect(201)
    const realId = (real.body as { loan: { id: string } }).loan.id
    const synthetic = await prisma.loan.create({
      data: {
        copyId: shelf.copyId,
        ownerId: owner.id,
        borrowerId: friend.id,
        status: 'REQUESTED',
        origin: 'RECORDED_EXISTING',
        requestedAt: null,
        handedAt: new Date('2026-01-10T00:00:00.000Z'),
      },
    })
    const before = await prisma.loan.findUniqueOrThrow({ where: { id: synthetic.id } })

    await request(app.getHttpServer())
      .post(url(`/me/library/${shelf.copyId}/archive`))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(await prisma.loan.findUniqueOrThrow({ where: { id: synthetic.id } })).toEqual(before)
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: realId } })).status).toBe('REJECTED')
    expect(
      await prisma.notification.count({ where: { userId: friend.id, type: 'LOAN_REJECTED' } }),
    ).toBe(0)
    expect(
      await prisma.notification.count({ where: { userId: other.id, type: 'LOAN_REJECTED' } }),
    ).toBe(1)
  })
})
