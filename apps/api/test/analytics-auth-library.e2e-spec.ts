import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { API_PREFIX, copyResponseSchema, sessionResponseSchema } from '@bookswap/shared'
import request from 'supertest'
import type { App } from 'supertest/types'
import { AnalyticsService } from '../src/analytics/analytics.service'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import { AUTH_SHUTDOWN_TIMEOUT } from '../src/auth/auth.constants'
import { AuthService } from '../src/auth/auth.service'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp, sessionCookie, uniqueEmail, VALID_PASSWORD } from './auth.helpers'

interface Account {
  id: string
  cookie: string
}

const url = (path: string): string => `${API_PREFIX}${path}`

async function register(app: INestApplication<App>, prefix: string): Promise<Account> {
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({
      email: uniqueEmail(prefix),
      password: VALID_PASSWORD,
      displayName: 'Analytics Test User',
    })
    .expect(201)

  return {
    id: sessionResponseSchema.parse(response.body).user.id,
    cookie: sessionCookie(response.headers),
  }
}

async function createEdition(prisma: PrismaService, userId: string): Promise<string> {
  const marker = `${String(process.pid)}-${String(Date.now())}-${userId}`
  const work = await prisma.work.create({
    data: {
      title: `Analytics work ${marker}`,
      titleNorm: `analytics work ${marker}`,
      origLang: 'en',
      createdById: userId,
    },
  })
  const edition = await prisma.edition.create({
    data: { workId: work.id, textKind: 'ORIGINAL', lang: 'en', createdById: userId },
  })

  return edition.id
}

describe('Auth and library product analytics (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it('records one SIGNUP_COMPLETED event for the new user', async () => {
    const account = await register(app, 'analytics-signup')

    const events = await prisma.productEvent.findMany({
      where: { subjectUserId: account.id, type: 'SIGNUP_COMPLETED' },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      properties: {},
      schemaVersion: 1,
      dedupeKey: computeDedupeKey('SIGNUP_COMPLETED', account.id, account.id),
    })
  })

  it('records BOOK_ADDED with the MANUAL method after creating a copy', async () => {
    const account = await register(app, 'analytics-book')
    const editionId = await createEdition(prisma, account.id)

    const response = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', account.cookie)
      .send({ editionId, note: 'This note must not enter analytics' })
      .expect(201)
    const copyId = copyResponseSchema.parse(response.body).copy.id

    const events = await prisma.productEvent.findMany({
      where: { subjectUserId: account.id, type: 'BOOK_ADDED' },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      properties: { method: 'MANUAL' },
      schemaVersion: 1,
      dedupeKey: computeDedupeKey('BOOK_ADDED', copyId, account.id),
    })
    expect(JSON.stringify(events[0]?.properties)).not.toContain(
      'This note must not enter analytics',
    )
  })

  it('records BOOK_ADDED with the BARCODE method supplied by the add-copy flow', async () => {
    const account = await register(app, 'analytics-barcode-book')
    const editionId = await createEdition(prisma, account.id)

    const response = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', account.cookie)
      .send({ editionId, entryMethod: 'BARCODE' })
      .expect(201)
    const copyId = copyResponseSchema.parse(response.body).copy.id

    const event = await prisma.productEvent.findUniqueOrThrow({
      where: { dedupeKey: computeDedupeKey('BOOK_ADDED', copyId, account.id) },
    })

    expect(event.properties).toEqual({ method: 'BARCODE' })
  })

  it('keeps registration successful when analytics storage fails', async () => {
    const createMany = jest
      .spyOn(prisma.productEvent, 'createMany')
      .mockRejectedValueOnce(new Error('Simulated analytics storage failure'))

    const account = await register(app, 'analytics-signup-failure')

    expect(createMany).toHaveBeenCalledTimes(1)
    await expect(prisma.user.findUnique({ where: { id: account.id } })).resolves.not.toBeNull()
    await expect(prisma.session.count({ where: { userId: account.id } })).resolves.toBe(1)
    await expect(
      prisma.productEvent.count({
        where: { subjectUserId: account.id, type: 'SIGNUP_COMPLETED' },
      }),
    ).resolves.toBe(0)
  })

  it('keeps copy creation successful when analytics storage fails', async () => {
    const account = await register(app, 'analytics-book-failure')
    const editionId = await createEdition(prisma, account.id)
    const createMany = jest
      .spyOn(prisma.productEvent, 'createMany')
      .mockRejectedValueOnce(new Error('Simulated analytics storage failure'))

    const response = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', account.cookie)
      .send({ editionId })
      .expect(201)
    const copyId = copyResponseSchema.parse(response.body).copy.id

    expect(createMany).toHaveBeenCalledTimes(1)
    await expect(prisma.copy.findUnique({ where: { id: copyId } })).resolves.not.toBeNull()
    await expect(
      prisma.productEvent.count({ where: { subjectUserId: account.id, type: 'BOOK_ADDED' } }),
    ).resolves.toBe(0)
  })
})

describe('SIGNUP_COMPLETED ordering (e2e)', () => {
  it('records only after session creation and auth workflow release', async () => {
    const app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(AUTH_SHUTDOWN_TIMEOUT).useValue(250)
      },
    })
    const analytics = app.get(AnalyticsService)
    const auth = app.get(AuthService)
    const prisma = app.get(PrismaService)
    const record = jest.spyOn(analytics, 'record').mockImplementation(async (input) => {
      await expect(prisma.session.count({ where: { userId: input.subjectUserId } })).resolves.toBe(
        1,
      )
      await expect(auth.onModuleDestroy()).resolves.toBeUndefined()
    })

    try {
      const account = await register(app, 'analytics-ordering')

      expect(record).toHaveBeenCalledWith({
        type: 'SIGNUP_COMPLETED',
        subjectUserId: account.id,
        domainEntityId: account.id,
        properties: {},
      })
    } finally {
      record.mockRestore()
      await app.close()
    }
  })
})
