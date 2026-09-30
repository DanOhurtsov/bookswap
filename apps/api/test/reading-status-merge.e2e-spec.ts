import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  readingListResponseSchema,
  readingStatusResponseSchema,
  workMergedDetailsSchema,
  type ReadingStatus,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import { beginRequest, gate, waitForBlockedBackend } from './concurrency.helpers'
import { createShelfCopy, registerAccount, url, type Account, type Shelf } from './loan.helpers'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10j.1 (docs/plan/stage-10-real-world-history.md, §0.15, §6.15 T15, §9.7; RS8).
 * Merge статусів читання: Q19 (новіший `updatedAt`), рівність → цільовий `Work`, явний `NOT_READ` бере
 * участь, перенесення не змінює `updatedAt`, `PUT` на злитий Work → 409, `GET` → канонічний.
 */
describe('Stage 10 (10j.1): статуси читання при merge (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let merge: MergeService
  let owner: Account

  const T = (day: number): Date => new Date(Date.UTC(2026, 0, day))

  const newShelf = (): Promise<Shelf> => createShelfCopy(app, owner)

  const seed = (
    userId: string,
    workId: string,
    status: ReadingStatus,
    updatedAt: Date,
  ): Promise<unknown> =>
    prisma.workReadingStatus.create({ data: { userId, workId, status, updatedAt } })

  const rowsOf = (
    userId: string,
  ): Promise<{ workId: string; status: ReadingStatus; updatedAt: Date }[]> =>
    prisma.workReadingStatus.findMany({
      where: { userId },
      select: { workId: true, status: true, updatedAt: true },
    })

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    merge = new MergeService(prisma)
    owner = await registerAccount(app, 's10j-mown')
  })

  afterAll(async () => {
    await app.close()
  })

  it('статус лише на вихідному Work переїжджає на цільовий із тим самим updatedAt; лічильник у MergeSummary', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-m1')
    const stamp = T(3)

    await seed(user.id, source.workId, 'READING', stamp)

    const summary = await merge.merge(source.workId, target.workId)

    expect(summary).toMatchObject({ readingStatusesMoved: 1, readingStatusDuplicatesRemoved: 0 })
    expect(await rowsOf(user.id)).toEqual([
      { workId: target.workId, status: 'READING', updatedAt: stamp },
    ])
  })

  it('Q19: новіший updatedAt перемагає незалежно від сили статусу (READING пізніше за READ)', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-m2')

    await seed(user.id, source.workId, 'READING', T(9))
    await seed(user.id, target.workId, 'READ', T(2))

    const summary = await merge.merge(source.workId, target.workId)

    expect(summary).toMatchObject({ readingStatusesMoved: 1, readingStatusDuplicatesRemoved: 1 })
    expect(await rowsOf(user.id)).toEqual([
      { workId: target.workId, status: 'READING', updatedAt: T(9) },
    ])
  })

  it('Q19: якщо новіший рядок на цільовому Work — лишається він, вихідний видаляється', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-m3')

    await seed(user.id, source.workId, 'READ', T(9))
    await seed(user.id, target.workId, 'READING', T(10))

    const summary = await merge.merge(source.workId, target.workId)

    expect(summary).toMatchObject({ readingStatusesMoved: 0, readingStatusDuplicatesRemoved: 1 })
    expect(await rowsOf(user.id)).toEqual([
      { workId: target.workId, status: 'READING', updatedAt: T(10) },
    ])
  })

  it('явний NOT_READ бере участь: старий READ і пізніше скидання → після merge NOT_READ (RS8)', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-m4')

    await seed(user.id, source.workId, 'READ', T(2))
    await seed(user.id, target.workId, 'NOT_READ', T(8))

    await merge.merge(source.workId, target.workId)

    expect(await rowsOf(user.id)).toEqual([
      { workId: target.workId, status: 'NOT_READ', updatedAt: T(8) },
    ])

    // Дзеркально: скидання на вихідному Work, пізніше за READ на цільовому.
    const [source2, target2] = [await newShelf(), await newShelf()]
    const user2 = await registerAccount(app, 's10j-m4b')

    await seed(user2.id, source2.workId, 'NOT_READ', T(8))
    await seed(user2.id, target2.workId, 'READ', T(2))

    await merge.merge(source2.workId, target2.workId)

    expect(await rowsOf(user2.id)).toEqual([
      { workId: target2.workId, status: 'NOT_READ', updatedAt: T(8) },
    ])
  })

  it('рівний updatedAt: виграє рядок цільового Work', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-m5')

    await seed(user.id, source.workId, 'READ', T(5))
    await seed(user.id, target.workId, 'READING', T(5))

    await merge.merge(source.workId, target.workId)

    expect(await rowsOf(user.id)).toEqual([
      { workId: target.workId, status: 'READING', updatedAt: T(5) },
    ])
  })

  it('різні користувачі не впливають один на одного; UNIQUE не падає на масовому переносі', async () => {
    const [source, target] = [await newShelf(), await newShelf()]
    const [a, b, c] = [
      await registerAccount(app, 's10j-m6a'),
      await registerAccount(app, 's10j-m6b'),
      await registerAccount(app, 's10j-m6c'),
    ]

    await seed(a.id, source.workId, 'READ', T(1))
    await seed(b.id, source.workId, 'READING', T(2))
    await seed(b.id, target.workId, 'READ', T(1))
    await seed(c.id, target.workId, 'READ', T(3))

    const summary = await merge.merge(source.workId, target.workId)

    // Переїжджають `a` (без конфлікту) і переможний рядок `b`; програшний рядок `b` видалено.
    expect(summary).toMatchObject({ readingStatusesMoved: 2, readingStatusDuplicatesRemoved: 1 })
    expect(await rowsOf(a.id)).toMatchObject([{ workId: target.workId, status: 'READ' }])
    expect(await rowsOf(b.id)).toMatchObject([{ workId: target.workId, status: 'READING' }])
    expect(await rowsOf(c.id)).toMatchObject([{ workId: target.workId, status: 'READ' }])
    expect(await prisma.workReadingStatus.count({ where: { workId: source.workId } })).toBe(0)
  })

  it('Q19 при очікуванні блокування: PUT A, що чекав на рядок, отримує час після зміни B, і merge лишає статус A', async () => {
    const [a, b] = [await newShelf(), await newShelf()]
    const user = await registerAccount(app, 's10j-mlock')
    const put = (workId: string, status: ReadingStatus): request.Test =>
      request(app.getHttpServer())
        .put(url(`/me/reading-statuses/${workId}`))
        .set('Cookie', user.cookie)
        .send({ status })

    await seed(user.id, a.workId, 'READING', T(1))

    // Інша транзакція тримає рядок статусу A, доки тест не відпустить.
    const hold = gate()
    const locker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
            SELECT "id" FROM "WorkReadingStatus"
            WHERE "userId" = ${user.id} AND "workId" = ${a.workId}
            FOR UPDATE
          `
        hold.entered.resolve()
        await hold.release.promise
      },
      { timeout: 15_000 },
    )

    await hold.entered.promise

    const putA = beginRequest(put(a.workId, 'READ'))

    // PUT A справді стоїть на блокуванні рядка — і лише тоді користувач змінює B.
    await waitForBlockedBackend(prisma)
    await put(b.workId, 'READING').expect(200)

    hold.release.resolve()
    await locker
    expect((await putA).status).toBe(200)

    const rowA = await prisma.workReadingStatus.findUniqueOrThrow({
      where: { userId_workId: { userId: user.id, workId: a.workId } },
    })
    const rowB = await prisma.workReadingStatus.findUniqueOrThrow({
      where: { userId_workId: { userId: user.id, workId: b.workId } },
    })

    expect(rowA.status).toBe('READ')
    expect(rowA.updatedAt.getTime()).toBeGreaterThan(rowB.updatedAt.getTime())

    // A — вихідний, тож рівність чи «цільовий за замовчуванням» не можуть випадково дати правильну відповідь.
    await merge.merge(a.workId, b.workId)

    expect(await rowsOf(user.id)).toEqual([
      { workId: b.workId, status: 'READ', updatedAt: rowA.updatedAt },
    ])
  }, 20_000)

  describe('після merge: Q21 і канонічний Work', () => {
    it('PUT на злитий workId → 409 WORK_MERGED з canonicalWorkId, рядок не створено; GET читає канонічний; тег іде за твором; mergedIntoId збережено', async () => {
      const [source, target] = [await newShelf(), await newShelf()]
      const user = await registerAccount(app, 's10j-m7')

      // Передача цьому користувачу на примірнику вихідного Work — тег піде за твором разом з Edition.
      const copy = await prisma.copy.findUniqueOrThrow({ where: { id: source.copyId } })

      await prisma.loan.create({
        data: {
          copyId: copy.id,
          ownerId: owner.id,
          borrowerId: user.id,
          origin: 'RECORDED_EXISTING',
          status: 'RETURNED',
          handedAt: T(4),
        },
      })
      await seed(user.id, target.workId, 'READ', T(6))

      await merge.merge(source.workId, target.workId)

      const conflict = await request(app.getHttpServer())
        .put(url(`/me/reading-statuses/${source.workId}`))
        .set('Cookie', user.cookie)
        .send({ status: 'READING' })
        .expect(409)
      const error = apiErrorSchema.parse(conflict.body)

      expect(error.code).toBe(API_ERROR_CODES.WORK_MERGED)
      expect(workMergedDetailsSchema.parse(error.details).canonicalWorkId).toBe(target.workId)
      expect(await rowsOf(user.id)).toMatchObject([{ workId: target.workId, status: 'READ' }])

      const read = await request(app.getHttpServer())
        .get(url(`/me/reading-statuses/${source.workId}`))
        .set('Cookie', user.cookie)
        .expect(200)

      expect(readingStatusResponseSchema.parse(read.body)).toEqual({
        workId: target.workId,
        status: 'READ',
        wasBorrowed: true,
      })

      const list = await request(app.getHttpServer())
        .get(url('/me/reading-list'))
        .set('Cookie', user.cookie)
        .expect(200)
      const body = readingListResponseSchema.parse(list.body)

      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({ status: 'READ', wasBorrowed: true })
      expect(body.items[0]?.work.id).toBe(target.workId)

      const merged = await prisma.work.findUniqueOrThrow({ where: { id: source.workId } })

      expect(merged.mergedIntoId).toBe(target.workId)
    })

    it('Q21: статус можна поставити Work без власності й позики; PUT на канонічний після merge працює', async () => {
      const [source, target] = [await newShelf(), await newShelf()]
      const user = await registerAccount(app, 's10j-m8')

      await merge.merge(source.workId, target.workId)

      await request(app.getHttpServer())
        .put(url(`/me/reading-statuses/${target.workId}`))
        .set('Cookie', user.cookie)
        .send({ status: 'READING' })
        .expect(200)

      expect(await rowsOf(user.id)).toMatchObject([{ workId: target.workId, status: 'READING' }])
    })
  })
})
