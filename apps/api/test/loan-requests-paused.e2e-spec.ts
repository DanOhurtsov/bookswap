import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  catalogDiscoveryResponseSchema,
  visibleLibraryResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
} from './loan.helpers'

/**
 * BS-148: «Пауза для запитів» (PROF-08, LOAN-01). New requests are refused with
 * 409 LOAN_REQUESTS_PAUSED and `canRequest` predicts it; requests already sent are left alone. The
 * pause is told only to someone who could otherwise ask.
 */
describe('Пауза для запитів (e2e, BS-148)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  const http = () => app.getHttpServer()

  async function setSettings(owner: Account, body: Record<string, unknown>): Promise<void> {
    await request(http()).patch(url('/me')).set('Cookie', owner.cookie).send(body).expect(200)
  }

  function errorCode(response: request.Response): string {
    return apiErrorSchema.parse(response.body).code
  }

  async function canRequestOnShelf(
    viewer: Account,
    owner: Account,
    copyId: string,
  ): Promise<boolean | undefined> {
    const response = await request(http())
      .get(url(`/users/${owner.id}/library`))
      .set('Cookie', viewer.cookie)
      .expect(200)

    return visibleLibraryResponseSchema
      .parse(response.body)
      .groups.flatMap((group) => group.copies)
      .find((copy) => copy.id === copyId)?.canRequest
  }

  async function friends(): Promise<{ owner: Account; friend: Account }> {
    const owner = await registerAccount(app, 'pause-owner')
    const friend = await registerAccount(app, 'pause-friend')

    await befriend(app, owner, friend)

    return { owner, friend }
  }

  it('друг отримує 409 LOAN_REQUESTS_PAUSED, кнопки немає; після паузи — знову можна', async () => {
    const { owner, friend } = await friends()
    const shelf = await createShelfCopy(app, owner)

    await setSettings(owner, { loanRequestsPaused: true })

    expect(await canRequestOnShelf(friend, owner, shelf.copyId)).toBe(false)
    expect(errorCode(await requestLoan(app, friend, shelf.copyId).expect(409))).toBe(
      API_ERROR_CODES.LOAN_REQUESTS_PAUSED,
    )
    expect(await prisma.loan.count({ where: { copyId: shelf.copyId } })).toBe(0)

    await setSettings(owner, { loanRequestsPaused: false })

    expect(await canRequestOnShelf(friend, owner, shelf.copyId)).toBe(true)
    await requestLoan(app, friend, shelf.copyId).expect(201)
  })

  it('сторонній про паузу не дізнається: PUBLIC-примірник — 403, як і без неї', async () => {
    const owner = await registerAccount(app, 'pause-owner')
    const stranger = await registerAccount(app, 'pause-stranger')
    const shelf = await createShelfCopy(app, owner, 'PUBLIC')

    await setSettings(owner, { loanRequestsPaused: true })

    expect(errorCode(await requestLoan(app, stranger, shelf.copyId).expect(403))).toBe(
      API_ERROR_CODES.FORBIDDEN,
    )
  })

  it('друг друга на паузі отримує ту саму 409', async () => {
    const { owner, friend } = await friends()
    const viewer = await registerAccount(app, 'pause-fof')
    const shelf = await createShelfCopy(app, owner)

    await befriend(app, friend, viewer)
    await setSettings(owner, { friendsOfFriendsAccess: true, loanRequestsPaused: true })

    expect(await canRequestOnShelf(viewer, owner, shelf.copyId)).toBe(false)
    expect(errorCode(await requestLoan(app, viewer, shelf.copyId).expect(409))).toBe(
      API_ERROR_CODES.LOAN_REQUESTS_PAUSED,
    )
  })

  it('запит, надісланий до паузи, лишається, і власник може його погодити', async () => {
    const { owner, friend } = await friends()
    const shelf = await createShelfCopy(app, owner)
    const created = await requestLoan(app, friend, shelf.copyId).expect(201)
    const loanId = (created.body as { loan: { id: string } }).loan.id

    await setSettings(owner, { loanRequestsPaused: true })

    await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
  })

  it('каталог передбачає ту саму відповідь: canRequest=false, поки триває пауза', async () => {
    const { owner, friend } = await friends()
    const shelf = await createShelfCopy(app, owner)
    const { title } = await prisma.work.findUniqueOrThrow({ where: { id: shelf.workId } })

    await setSettings(owner, { loanRequestsPaused: true })

    const response = await request(http())
      .get(url(`/catalog/discover?q=${encodeURIComponent(title)}`))
      .set('Cookie', friend.cookie)
      .expect(200)
    const copies = catalogDiscoveryResponseSchema
      .parse(response.body)
      .results.find((result) => result.work.id === shelf.workId)
      ?.locations.flatMap((location) => location.copies)

    expect(copies?.map((copy) => [copy.id, copy.canRequest])).toEqual([[shelf.copyId, false]])
  })
})
