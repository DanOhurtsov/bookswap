import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  copyHistoryResponseSchema,
  readingListResponseSchema,
  readingStatusResponseSchema,
  setReadingStatusResponseSchema,
  workHistoryResponseSchema,
  type LoanStatus,
  type ReadingStatus,
} from '@bookswap/shared'
import { createTestApp } from './auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  registerAccount,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from './loan.helpers'
import { recordedLoan, utcDay } from './recorded.helpers'
import { ACTUAL_HANDOVER_STATUSES } from '../src/history/actual-handover'
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10j.1 (docs/plan/stage-10-real-world-history.md, §6.15, §9.7; RS1–RS11, RS13).
 * Дані синтетичні. Позики — через справжні переходи `/loans`; записані/гостьові виставляються напряму в БД.
 */
describe('Stage 10 (10j.1): особисті статуси читання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  let reader: Account
  let friend: Account
  let stranger: Account
  let blocked: Account
  let shelf: Shelf

  const put = (account: Account, workId: string, body: unknown): request.Test =>
    request(app.getHttpServer())
      .put(url(`/me/reading-statuses/${workId}`))
      .set('Cookie', account.cookie)
      .send(body as object)

  const getStatus = (account: Account, workId: string): request.Test =>
    request(app.getHttpServer())
      .get(url(`/me/reading-statuses/${workId}`))
      .set('Cookie', account.cookie)

  const list = (account: Account, query = ''): request.Test =>
    request(app.getHttpServer())
      .get(url(`/me/reading-list${query}`))
      .set('Cookie', account.cookie)

  const rowOf = (
    userId: string,
    workId: string,
  ): Promise<{ status: ReadingStatus; updatedAt: Date } | null> =>
    prisma.workReadingStatus.findUnique({
      where: { userId_workId: { userId, workId } },
      select: { status: true, updatedAt: true },
    })

  const rowCount = (userId: string): Promise<number> =>
    prisma.workReadingStatus.count({ where: { userId } })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Окрема книжка (Work→Edition→Copy) у власника. */
  const newShelf = (): Promise<Shelf> => createShelfCopy(app, owner)

  async function statusOf(account: Account, workId: string): Promise<ReadingStatus> {
    const res = await getStatus(account, workId).expect(200)

    return readingStatusResponseSchema.parse(res.body).status
  }

  async function wasBorrowed(account: Account, workId: string): Promise<boolean> {
    const res = await getStatus(account, workId).expect(200)

    return readingStatusResponseSchema.parse(res.body).wasBorrowed
  }

  async function seedLoan(
    work: Shelf,
    data: { status: LoanStatus; handedAt: Date | null; borrowerId?: string },
  ): Promise<void> {
    const copy = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId: work.editionId, visibility: 'FRIENDS' })
      .expect(201)

    await prisma.loan.create({
      data: {
        copyId: (copy.body as { copy: { id: string } }).copy.id,
        ownerId: owner.id,
        borrowerId: data.borrowerId ?? reader.id,
        origin: 'RECORDED_EXISTING',
        status: data.status,
        handedAt: data.handedAt,
      },
    })
  }

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 's10j-own')
    reader = await registerAccount(app, 's10j-rdr')
    friend = await registerAccount(app, 's10j-fri')
    stranger = await registerAccount(app, 's10j-str')
    blocked = await registerAccount(app, 's10j-blk')

    await befriend(app, owner, reader)
    await befriend(app, owner, friend)
    await befriend(app, owner, blocked)
    await request(app.getHttpServer())
      .post(url(`/friends/${blocked.id}/block`))
      .set('Cookie', owner.cookie)
      .expect(204)

    shelf = await newShelf()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('RS1: ручний статус', () => {
    it('без рядка GET дає NOT_READ, а PUT NOT_READ рядка не створює і нічого не міняє', async () => {
      const work = await newShelf()

      expect(await statusOf(reader, work.workId)).toBe('NOT_READ')

      const res = await put(reader, work.workId, { status: 'NOT_READ' }).expect(200)

      expect(setReadingStatusResponseSchema.parse(res.body)).toEqual({
        workId: work.workId,
        status: 'NOT_READ',
      })
      expect(await rowOf(reader.id, work.workId)).toBeNull()
    })

    it('READING → READ → READING: довільні переходи, кожен змінює updatedAt', async () => {
      const work = await newShelf()
      const seen: number[] = []

      for (const status of ['READING', 'READ', 'READING'] as const) {
        await put(reader, work.workId, { status }).expect(200)

        const row = await rowOf(reader.id, work.workId)

        expect(row?.status).toBe(status)
        seen.push(row?.updatedAt.getTime() ?? 0)
        await sleep(5)
      }

      expect(new Set(seen).size).toBe(3)
      expect(seen).toEqual([...seen].sort((a, b) => a - b))
    })

    it('повторний PUT того самого статусу не змінює updatedAt', async () => {
      const work = await newShelf()

      await put(reader, work.workId, { status: 'READ' }).expect(200)

      const before = await rowOf(reader.id, work.workId)

      await sleep(20)
      await put(reader, work.workId, { status: 'READ' }).expect(200)

      expect(await rowOf(reader.id, work.workId)).toEqual(before)
    })

    it('READ → NOT_READ лишає явний рядок із новим updatedAt; повторний NOT_READ — no-op; GET дає NOT_READ', async () => {
      const work = await newShelf()

      await put(reader, work.workId, { status: 'READ' }).expect(200)

      const read = await rowOf(reader.id, work.workId)

      await sleep(20)
      await put(reader, work.workId, { status: 'NOT_READ' }).expect(200)

      const reset = await rowOf(reader.id, work.workId)

      expect(reset?.status).toBe('NOT_READ')
      expect(reset!.updatedAt.getTime()).toBeGreaterThan(read!.updatedAt.getTime())
      expect(await statusOf(reader, work.workId)).toBe('NOT_READ')

      await sleep(20)
      await put(reader, work.workId, { status: 'NOT_READ' }).expect(200)

      expect(await rowOf(reader.id, work.workId)).toEqual(reset)
    })

    it.each([
      ['невідомий статус', { status: 'DONE' }],
      ['без статусу', {}],
      ['нижній регістр', { status: 'read' }],
      ['зайве поле userId', { status: 'READ', userId: 'someone' }],
    ])('негатив: %s → 400 VALIDATION_ERROR', async (_name, body) => {
      const res = await put(reader, shelf.workId, body).expect(400)

      expect(apiErrorSchema.parse(res.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('негатив: невідомий Work → 404 NOT_FOUND (PUT і GET), без сесії → 401', async () => {
      const put404 = await put(reader, 'no-such-work', { status: 'READ' }).expect(404)
      const get404 = await getStatus(reader, 'no-such-work').expect(404)

      expect(apiErrorSchema.parse(put404.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
      expect(apiErrorSchema.parse(get404.body).code).toBe(API_ERROR_CODES.NOT_FOUND)

      await request(app.getHttpServer())
        .put(url(`/me/reading-statuses/${shelf.workId}`))
        .send({ status: 'READ' })
        .expect(401)
      await request(app.getHttpServer())
        .get(url(`/me/reading-statuses/${shelf.workId}`))
        .expect(401)
      await request(app.getHttpServer()).get(url('/me/reading-list')).expect(401)
    })
  })

  describe('RS2, RS3, RS5: позика не ставить статус, повернення й архів не стирають ні статус, ні тег', () => {
    it('повний цикл request → approve → hand_over → return не створює статусу; тег з’являється лише після передачі', async () => {
      const work = await newShelf()
      const before = await rowCount(reader.id)
      const created = await requestLoan(app, reader, work.copyId).expect(201)
      const loanId = (created.body as { loan: { id: string } }).loan.id

      expect(await wasBorrowed(reader, work.workId)).toBe(false)

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
      expect(await wasBorrowed(reader, work.workId)).toBe(false)

      await actOnLoan(app, reader, loanId, { action: 'hand_over' }).expect(200)
      expect(await wasBorrowed(reader, work.workId)).toBe(true)

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      expect(await wasBorrowed(reader, work.workId)).toBe(true)
      expect(await statusOf(reader, work.workId)).toBe('NOT_READ')
      expect(await rowCount(reader.id)).toBe(before)
    })

    it('READ до й після return: книжка лишається у списку, Loan не змінюється; тег незалежний від зміни статусу й архіву', async () => {
      const work = await newShelf()
      const created = await requestLoan(app, reader, work.copyId).expect(201)
      const loanId = (created.body as { loan: { id: string } }).loan.id

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
      await actOnLoan(app, reader, loanId, { action: 'hand_over' }).expect(200)
      await put(reader, work.workId, { status: 'READ' }).expect(200)
      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      const loanAfterReturn = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      for (const status of ['READING', 'READ', 'NOT_READ', 'READ'] as const) {
        await put(reader, work.workId, { status }).expect(200)
        expect(await wasBorrowed(reader, work.workId)).toBe(true)
      }

      const res = await list(reader, '?status=READ').expect(200)
      const body = readingListResponseSchema.parse(res.body)
      const item = body.items.find((entry) => entry.work.id === work.workId)

      expect(item).toMatchObject({ status: 'READ', wasBorrowed: true })
      expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(
        loanAfterReturn,
      )

      // Архівування примірника власником: тег лишається (R-6).
      await request(app.getHttpServer())
        .post(url(`/me/library/${work.copyId}/archive`))
        .set('Cookie', owner.cookie)
        .expect(200)
      expect(await wasBorrowed(reader, work.workId)).toBe(true)
    })

    it('mark_lost і recover після передачі не стирають тег і не ставлять статусу (API)', async () => {
      const work = await newShelf()
      const before = await rowCount(reader.id)
      const created = await requestLoan(app, reader, work.copyId).expect(201)
      const loanId = (created.body as { loan: { id: string } }).loan.id

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
      await actOnLoan(app, reader, loanId, { action: 'hand_over' }).expect(200)
      expect(await wasBorrowed(reader, work.workId)).toBe(true)

      await actOnLoan(app, owner, loanId, { action: 'mark_lost' }).expect(200)
      expect(await wasBorrowed(reader, work.workId)).toBe(true)

      await actOnLoan(app, owner, loanId, { action: 'recover', effectiveAt: utcDay(-1) }).expect(
        200,
      )

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })

      expect(loan.status).toBe('LOST')
      expect(loan.handedAt).not.toBeNull()
      expect(await wasBorrowed(reader, work.workId)).toBe(true)
      expect(await statusOf(reader, work.workId)).toBe('NOT_READ')
      expect(await rowCount(reader.id)).toBe(before)
    })

    it('паритет: список статусів передачі — рівно HANDED_OVER, RETURNED, LOST', () => {
      expect([...ACTUAL_HANDOVER_STATUSES].sort()).toEqual(['HANDED_OVER', 'LOST', 'RETURNED'])
    })
  })

  describe('RS4: тег лише після фактичної передачі цьому користувачу', () => {
    const HANDED = new Date('2026-01-10T10:00:00Z')

    it.each([
      ['REQUESTED', 'REQUESTED', null, false],
      ['APPROVED без передачі', 'APPROVED', null, false],
      ['REJECTED', 'REJECTED', null, false],
      ['CANCELLED', 'CANCELLED', null, false],
      ['PENDING_CONFIRMATION', 'PENDING_CONFIRMATION', HANDED, false],
      ['DECLINED', 'DECLINED', HANDED, false],
      ['LOST без handedAt', 'LOST', null, false],
      ['HANDED_OVER', 'HANDED_OVER', HANDED, true],
      ['RETURNED', 'RETURNED', HANDED, true],
      ['LOST із handedAt', 'LOST', HANDED, true],
    ] as const)('%s → wasBorrowed=%s', async (_name, status, handedAt, expected) => {
      const work = await newShelf()

      await seedLoan(work, { status, handedAt })

      expect(await wasBorrowed(reader, work.workId)).toBe(expected)
    })

    it('записана позика (API): до confirm_record тега немає, після підтвердження — є; decline_record тега не дає', async () => {
      const confirmed = await newShelf()
      const loan = await recordedLoan(app, owner, reader, confirmed.copyId)

      expect(loan.status).toBe('PENDING_CONFIRMATION')
      expect(await wasBorrowed(reader, confirmed.workId)).toBe(false)

      await actOnLoan(app, reader, loan.id, { action: 'confirm_record' }).expect(200)

      expect(await wasBorrowed(reader, confirmed.workId)).toBe(true)
      expect(await statusOf(reader, confirmed.workId)).toBe('NOT_READ')

      const declined = await newShelf()
      const other = await recordedLoan(app, owner, reader, declined.copyId)

      await actOnLoan(app, reader, other.id, { action: 'decline_record' }).expect(200)

      expect(await wasBorrowed(reader, declined.workId)).toBe(false)
    })

    it('тег належить позичальнику: власник і сторонній його не мають', async () => {
      const work = await newShelf()

      await seedLoan(work, { status: 'HANDED_OVER', handedAt: HANDED })

      expect(await wasBorrowed(reader, work.workId)).toBe(true)
      expect(await wasBorrowed(owner, work.workId)).toBe(false)
      expect(await wasBorrowed(stranger, work.workId)).toBe(false)
    })
  })

  describe('RS6, RS7, RS10: дедуплікація, книга без позик, гості', () => {
    it('кілька позик, примірників і видань одного Work → один рядок списку й один тег; UNIQUE діє в БД', async () => {
      const work = await newShelf()
      const second = await request(app.getHttpServer())
        .post(url(`/works/${work.workId}/editions`))
        .set('Cookie', owner.cookie)
        .send({ publisher: 'Інше', year: 2021 })
        .expect(201)
      const otherEdition = (second.body as { edition: { id: string } }).edition.id

      await seedLoan(work, { status: 'RETURNED', handedAt: new Date('2026-01-01T00:00:00Z') })
      await seedLoan(work, { status: 'HANDED_OVER', handedAt: new Date('2026-02-01T00:00:00Z') })
      await seedLoan(
        { ...work, editionId: otherEdition },
        { status: 'RETURNED', handedAt: new Date('2026-03-01T00:00:00Z') },
      )
      await put(reader, work.workId, { status: 'READ' }).expect(200)

      const body = readingListResponseSchema.parse((await list(reader, '?limit=50')).body)

      expect(body.items.filter((entry) => entry.work.id === work.workId)).toHaveLength(1)
      expect(await wasBorrowed(reader, work.workId)).toBe(true)

      await expect(
        prisma.workReadingStatus.create({
          data: { userId: reader.id, workId: work.workId, status: 'READING' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' })
    })

    it('книга без позик: статус ставиться, у списку є, тега немає', async () => {
      const work = await newShelf()

      await put(stranger, work.workId, { status: 'READING' }).expect(200)

      const body = readingListResponseSchema.parse((await list(stranger)).body)

      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({ status: 'READING', wasBorrowed: false })
    })

    it('гостьова позика не дає тега нікому й не створює рядків', async () => {
      const work = await newShelf()
      const contact = await prisma.externalBorrower.create({
        data: { ownerId: owner.id, alias: 'синтетичний гість 10j' },
      })
      const copy = await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', owner.cookie)
        .send({ editionId: work.editionId, visibility: 'FRIENDS' })
        .expect(201)
      const copyId = (copy.body as { copy: { id: string } }).copy.id
      const rowsBefore = await prisma.workReadingStatus.count()

      await prisma.$transaction([
        prisma.copy.update({
          where: { id: copyId },
          data: { status: 'LENT_OUT', currentHolderId: null, heldByContactId: contact.id },
        }),
        prisma.loan.create({
          data: {
            copyId,
            ownerId: owner.id,
            borrowerId: null,
            borrowerContactId: contact.id,
            borrowerKind: 'GUEST',
            origin: 'RECORDED_GUEST',
            requestedAt: null,
            status: 'HANDED_OVER',
            handedAt: new Date('2026-01-10T10:00:00Z'),
          },
        }),
      ])

      for (const account of [owner, reader, friend, stranger]) {
        expect(await wasBorrowed(account, work.workId)).toBe(false)
      }

      expect(await prisma.workReadingStatus.count()).toBe(rowsBefore)
    })
  })

  describe('RS9: приватність (R-8)', () => {
    it('статус читача не видно нікому іншому: немає маршруту з userId, а GET іншого акаунта показує його власний стан', async () => {
      const work = await newShelf()

      await put(reader, work.workId, { status: 'READ' }).expect(200)

      for (const other of [owner, friend, stranger, blocked]) {
        expect(await statusOf(other, work.workId)).toBe('NOT_READ')
        const items = readingListResponseSchema.parse((await list(other)).body).items

        expect(items.map((entry) => entry.work.id)).not.toContain(work.workId)
      }

      for (const path of [
        `/me/reading-statuses/${reader.id}`,
        `/users/${reader.id}/reading-statuses`,
        `/users/${reader.id}/reading-list`,
        `/me/reading-list/${reader.id}`,
      ]) {
        const res = await request(app.getHttpServer()).get(url(path)).set('Cookie', owner.cookie)

        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(JSON.stringify(res.body)).not.toContain('READ')
      }
    })

    it('спільні відповіді (history, holders, loans, friends, library, discovery) не містять статусу чи wasBorrowed', async () => {
      const work = await newShelf()
      const created = await requestLoan(app, reader, work.copyId).expect(201)
      const loanId = (created.body as { loan: { id: string } }).loan.id

      await actOnLoan(app, owner, loanId, { action: 'approve' }).expect(200)
      await actOnLoan(app, reader, loanId, { action: 'hand_over' }).expect(200)
      await put(reader, work.workId, { status: 'READ' }).expect(200)

      const shared = [
        `/works/${work.workId}/history`,
        `/copies/${work.copyId}/history`,
        '/me/history',
        `/works/${work.workId}/holders`,
        `/works/${work.workId}`,
        '/loans',
        '/friends',
        '/me/library',
        '/me/wishlist',
        '/me/notifications',
      ]

      for (const viewer of [owner, reader, friend]) {
        for (const path of shared) {
          const res = await request(app.getHttpServer()).get(url(path)).set('Cookie', viewer.cookie)

          if (res.status >= 400) continue

          const text = JSON.stringify(res.body)

          expect({
            path,
            leaked: /wasBorrowed|readingStatus|"status":"READ"|NOT_READ/.test(text),
          }).toEqual({
            path,
            leaked: false,
          })
        }
      }

      const history = workHistoryResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .get(url(`/works/${work.workId}/history`))
            .set('Cookie', friend.cookie)
            .expect(200)
        ).body,
      )

      expect(history.entries).toHaveLength(1)
      expect(
        copyHistoryResponseSchema.parse(
          (
            await request(app.getHttpServer())
              .get(url(`/copies/${work.copyId}/history`))
              .set('Cookie', owner.cookie)
              .expect(200)
          ).body,
        ).entries,
      ).toHaveLength(1)
    })

    it('запис статусу не породжує ні Notification, ні ProductEvent', async () => {
      const work = await newShelf()
      const notifications = await prisma.notification.count()
      const events = await prisma.productEvent.count()

      await put(reader, work.workId, { status: 'READ' }).expect(200)
      await put(reader, work.workId, { status: 'NOT_READ' }).expect(200)

      expect(await prisma.notification.count()).toBe(notifications)
      expect(await prisma.productEvent.count()).toBe(events)
    })
  })

  describe('RS11: список', () => {
    let lister: Account
    const works: string[] = []

    beforeAll(async () => {
      lister = await registerAccount(app, 's10j-lst')

      // Порядок постановки: w0 READ, w1 READING, w2 READ, w3 READING, w4 READ, w5 явний NOT_READ.
      const plan: ReadingStatus[] = ['READ', 'READING', 'READ', 'READING', 'READ', 'READ']

      for (const status of plan) {
        const work = await newShelf()

        works.push(work.workId)
        await put(lister, work.workId, { status }).expect(200)
        await sleep(5)
      }

      await put(lister, works[5]!, { status: 'NOT_READ' }).expect(200)
    })

    it('порожній стан', async () => {
      const empty = await registerAccount(app, 's10j-emp')
      const body = readingListResponseSchema.parse((await list(empty).expect(200)).body)

      expect(body).toEqual({ items: [], nextCursor: null })
    })

    it('лише READING/READ, явного NOT_READ немає, порядок за updatedAt спадно', async () => {
      const body = readingListResponseSchema.parse((await list(lister).expect(200)).body)
      const ids = body.items.map((entry) => entry.work.id)

      expect(ids).toEqual([works[4], works[3], works[2], works[1], works[0]])
      expect(ids).not.toContain(works[5])
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('фільтр за статусом; NOT_READ як фільтр → 400', async () => {
      const read = readingListResponseSchema.parse((await list(lister, '?status=READ')).body)
      const reading = readingListResponseSchema.parse((await list(lister, '?status=READING')).body)

      expect(read.items.map((entry) => entry.work.id)).toEqual([works[4], works[2], works[0]])
      expect(reading.items.map((entry) => entry.work.id)).toEqual([works[3], works[1]])

      const bad = await list(lister, '?status=NOT_READ').expect(400)

      expect(apiErrorSchema.parse(bad.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('курсорна пагінація стабільна: сторінки не перетинаються й дають повний список; зміна між сторінками не дублює', async () => {
      const collected: string[] = []
      let cursor: string | null = null

      for (let page = 0; page < 5; page += 1) {
        const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
        const body = readingListResponseSchema.parse((await list(lister, query).expect(200)).body)

        collected.push(...body.items.map((entry) => entry.work.id))
        cursor = body.nextCursor

        if (page === 0) {
          // Оновлення вже показаного рядка (він піде нагору) не дублює його на наступних сторінках.
          await put(lister, works[4]!, { status: 'READING' }).expect(200)
        }

        if (cursor === null) break
      }

      expect(cursor).toBeNull()
      expect(collected).toEqual([works[4], works[3], works[2], works[1], works[0]])
    })

    it('рівний updatedAt: курсор розрізняє рядки за id', async () => {
      const tie = await registerAccount(app, 's10j-tie')
      const stamp = new Date('2026-05-05T05:05:05.005Z')
      const made: string[] = []

      for (let index = 0; index < 5; index += 1) {
        const work = await newShelf()

        made.push(work.workId)
        await prisma.workReadingStatus.create({
          data: { userId: tie.id, workId: work.workId, status: 'READ', updatedAt: stamp },
        })
      }

      const seen: string[] = []
      let cursor: string | null = null

      do {
        const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
        const body = readingListResponseSchema.parse((await list(tie, query).expect(200)).body)

        seen.push(...body.items.map((entry) => entry.work.id))
        cursor = body.nextCursor
      } while (cursor !== null)

      expect([...seen].sort()).toEqual([...made].sort())
      expect(new Set(seen).size).toBe(5)
    })

    it('хибний курсор і limit → 400', async () => {
      await list(lister, '?cursor=not-a-cursor').expect(400)
      await list(lister, '?limit=51').expect(400)
      await list(lister, '?limit=0').expect(400)
      await list(lister, '?userId=x').expect(400)
    })

    it('тег усіх рядків сторінки — без запиту Loan на рядок', async () => {
      const spy = jest.spyOn(prisma.loan, 'findMany')

      try {
        await list(lister, '?limit=50').expect(200)

        expect(spy).toHaveBeenCalledTimes(1)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('RS13: усі маршрути під /api/v1, помилки з code', () => {
    it('маршрут поза /api/v1 не існує', async () => {
      const res = await request(app.getHttpServer())
        .get('/me/reading-list')
        .set('Cookie', reader.cookie)

      expect(res.status).toBe(404)
    })

    it('відповіді відповідають строгим zod-схемам', async () => {
      const work = await newShelf()
      const set = await put(reader, work.workId, { status: 'READING' }).expect(200)

      setReadingStatusResponseSchema.parse(set.body)
      readingStatusResponseSchema.parse((await getStatus(reader, work.workId).expect(200)).body)
      readingListResponseSchema.parse((await list(reader).expect(200)).body)
    })
  })
})
