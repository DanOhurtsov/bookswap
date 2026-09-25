import 'reflect-metadata'
import request from 'supertest'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  copyHistoryResponseSchema,
  myHistoryResponseSchema,
  workHistoryResponseSchema,
  type LoanStatus,
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
import { PrismaService } from '../src/prisma/prisma.service'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/**
 * Stage 10, крок 10b (docs/plan/stage-10-real-world-history.md, §6.7, §9.5; H1–H4).
 *
 * «Хто читав» (`GET /works/:id/history`) — лише фактична передача; activity history
 * (`/copies/:id/history`, `/me/history`) зберігає все. Дані синтетичні. Записані позики й гість
 * виставляються напряму в БД: API для них з'явиться в кроках 10e/10f.
 */
describe('Stage 10 (10b): «Хто читав» і activity history (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let owner: Account
  let borrower: Account
  let friend: Account
  let stranger: Account
  let blocked: Account
  let shelf: Shelf
  /** Мітка сценарію → примірник. Кожна позика лежить на власному примірнику одного твору. */
  const copies: Record<string, string> = {}
  const loans: Record<string, string> = {}
  const copyOf = (label: string): string => {
    const id = copies[label]

    if (id === undefined) throw new Error(`no copy for ${label}`)

    return id
  }
  const GUEST_ALIAS = 'синтетичний гість 10b'

  const get = (account: Account, path: string): request.Test =>
    request(app.getHttpServer()).get(url(path)).set('Cookie', account.cookie)

  const setHolderNames = (account: Account, value: boolean): request.Test =>
    request(app.getHttpServer())
      .patch(url('/me'))
      .set('Cookie', account.cookie)
      .send({ showHolderNames: value })

  async function extraCopy(label: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId: shelf.editionId, visibility: 'FRIENDS' })
      .expect(201)

    const copyId = (created.body as { copy: { id: string } }).copy.id

    copies[label] = copyId

    return copyId
  }

  async function viaApi(label: string, steps: [Account, string][]): Promise<void> {
    const copyId = label === 'first' ? shelf.copyId : await extraCopy(label)

    copies[label] = copyId

    const created = await requestLoan(app, borrower, copyId).expect(201)
    const loanId = (created.body as { loan: { id: string } }).loan.id

    loans[label] = loanId

    for (const [actor, action] of steps) {
      await actOnLoan(app, actor, loanId, { action }).expect(200)
    }
  }

  /** Позика напряму в БД: статуси й дати без request-flow. Примірник лишається вдома. */
  async function seedLoan(
    label: string,
    data: {
      status: LoanStatus
      origin?: 'REQUESTED' | 'RECORDED_EXISTING'
      handedAt?: Date | null
      requestedAt?: Date | null
      borrowerId?: string
    },
  ): Promise<void> {
    const copyId = await extraCopy(label)
    const origin = data.origin ?? 'RECORDED_EXISTING'
    const created = await prisma.loan.create({
      data: {
        copyId,
        ownerId: owner.id,
        borrowerId: data.borrowerId ?? borrower.id,
        origin,
        status: data.status,
        handedAt: data.handedAt ?? null,
        ...(origin === 'RECORDED_EXISTING' && data.requestedAt === undefined
          ? {}
          : { requestedAt: data.requestedAt }),
      },
    })

    loans[label] = created.id
  }

  const HANDED = new Date('2026-01-10T10:00:00Z')

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    owner = await registerAccount(app, 's10b-own')
    borrower = await registerAccount(app, 's10b-bor')
    friend = await registerAccount(app, 's10b-fri')
    stranger = await registerAccount(app, 's10b-str')
    blocked = await registerAccount(app, 's10b-blk')

    await befriend(app, owner, borrower)
    await befriend(app, owner, friend)
    await befriend(app, owner, blocked)
    await request(app.getHttpServer())
      .post(url(`/friends/${blocked.id}/block`))
      .set('Cookie', owner.cookie)
      .expect(204)

    shelf = await createShelfCopy(app, owner)

    // Реальний request-flow.
    await viaApi('first', [[owner, 'approve']])
    await viaApi('rejected', [[owner, 'reject']])
    await viaApi('cancelled', [[borrower, 'cancel']])
    await viaApi('requested', [])
    await viaApi('approved', [[owner, 'approve']])
    await viaApi('handed', [
      [owner, 'approve'],
      [borrower, 'hand_over'],
    ])
    await viaApi('returned', [
      [owner, 'approve'],
      [borrower, 'hand_over'],
      [owner, 'return'],
    ])
    await viaApi('lost', [
      [owner, 'approve'],
      [borrower, 'hand_over'],
      [owner, 'mark_lost'],
    ])

    // Напряму в БД.
    await seedLoan('lost-no-handed', { status: 'LOST', handedAt: null })
    await seedLoan('pending', { status: 'PENDING_CONFIRMATION', handedAt: HANDED })
    await seedLoan('declined', { status: 'DECLINED', handedAt: HANDED })
    // Записана власником позика з ненульовим requestedAt (дефолт БД) — підтверджена й передана.
    await seedLoan('recorded-handed', { status: 'HANDED_OVER', handedAt: HANDED })
    await seedLoan('recorded-lost', { status: 'LOST', handedAt: HANDED })

    // Гостьова позика: зареєстрованого позичальника немає.
    const contact = await prisma.externalBorrower.create({
      data: { ownerId: owner.id, alias: GUEST_ALIAS },
    })
    const guestCopy = await extraCopy('guest')

    await prisma.$transaction([
      prisma.copy.update({
        where: { id: guestCopy },
        data: { status: 'LENT_OUT', currentHolderId: null, heldByContactId: contact.id },
      }),
      prisma.loan.create({
        data: {
          copyId: guestCopy,
          ownerId: owner.id,
          borrowerId: null,
          borrowerContactId: contact.id,
          borrowerKind: 'GUEST',
          origin: 'RECORDED_GUEST',
          requestedAt: null,
          status: 'HANDED_OVER',
          handedAt: HANDED,
        },
      }),
    ])
  })

  afterAll(async () => {
    await app.close()
  })

  const READ_LABELS = ['handed', 'returned', 'lost', 'recorded-handed', 'recorded-lost', 'guest']
  const NOT_READ_LABELS = [
    'first',
    'rejected',
    'cancelled',
    'requested',
    'approved',
    'lost-no-handed',
    'pending',
    'declined',
  ]

  const workCopyIds = async (viewer: Account): Promise<string[]> => {
    const response = await get(viewer, `/works/${shelf.workId}/history`).expect(200)

    return workHistoryResponseSchema
      .parse(response.body)
      .entries.map((item) => item.copyId)
      .sort()
  }

  const idsOf = (labels: string[]): string[] => labels.map(copyOf).sort()

  describe('H1: «Хто читав» — лише фактична передача', () => {
    it('віддає HANDED_OVER, RETURNED, LOST з handedAt (і записані/гостьову передачу) — і нічого більше', async () => {
      for (const viewer of [owner, friend]) {
        expect(await workCopyIds(viewer)).toEqual(idsOf(READ_LABELS))
      }
    })

    it('LOST без handedAt не читання, LOST з handedAt — читання (Q8)', async () => {
      const ids = await workCopyIds(friend)

      expect(ids).toContain(copyOf('lost'))
      expect(ids).toContain(copyOf('recorded-lost'))
      expect(ids).not.toContain(copyOf('lost-no-handed'))
    })

    it.each(NOT_READ_LABELS)('статус-не-читання «%s» відсутній у «Хто читав»', async (label) => {
      for (const viewer of [owner, friend]) {
        expect(await workCopyIds(viewer)).not.toContain(copyOf(label))
      }
    })

    it('записана власником позика несе origin; звичайна — REQUESTED', async () => {
      const response = await get(friend, `/works/${shelf.workId}/history`).expect(200)
      const byCopy = new Map(
        workHistoryResponseSchema
          .parse(response.body)
          .entries.map((item) => [item.copyId, item.entry]),
      )

      expect(byCopy.get(copyOf('recorded-handed'))?.origin).toBe('RECORDED_EXISTING')
      expect(byCopy.get(copyOf('handed'))?.origin).toBe('REQUESTED')
      expect(byCopy.get(copyOf('guest'))?.origin).toBe('RECORDED_GUEST')
    })
  })

  describe('H2: activity history зберігає REJECTED/CANCELLED', () => {
    it.each(['rejected', 'cancelled'])(
      '/copies/:id/history (%s) — власник і друг бачать запис',
      async (label) => {
        const expected = label === 'rejected' ? 'REJECTED' : 'CANCELLED'

        for (const viewer of [owner, friend]) {
          const response = await get(viewer, `/copies/${copyOf(label)}/history`).expect(200)
          const history = copyHistoryResponseSchema.parse(response.body)

          expect(history.entries.map((entry) => entry.status)).toEqual([expected])
        }
      },
    )

    it('/me/history містить REJECTED і CANCELLED в обох напрямках, а також повний набір статусів', async () => {
      const own = myHistoryResponseSchema.parse((await get(owner, '/me/history').expect(200)).body)
      const theirs = myHistoryResponseSchema.parse(
        (await get(borrower, '/me/history').expect(200)).body,
      )

      for (const list of [own.lent, theirs.borrowed]) {
        const statuses = list.map((item) => item.entry.status)

        expect(statuses).toEqual(expect.arrayContaining(['REJECTED', 'CANCELLED', 'REQUESTED']))
        expect(list.map((item) => item.copy.id)).toEqual(
          expect.arrayContaining([copyOf('rejected'), copyOf('cancelled')]),
        )
      }
    })

    it('/me/history показує сторонам PENDING_CONFIRMATION і DECLINED', async () => {
      for (const [account, key] of [
        [owner, 'lent'],
        [borrower, 'borrowed'],
      ] as const) {
        const body = myHistoryResponseSchema.parse(
          (await get(account, '/me/history').expect(200)).body,
        )
        const statuses = body[key].map((item) => item.entry.status)

        expect(statuses).toEqual(expect.arrayContaining(['PENDING_CONFIRMATION', 'DECLINED']))
      }
    })
  })

  describe('H3: ролі й showHolderNames у «Хто читав»', () => {
    const rawWork = async (viewer: Account): Promise<string> =>
      JSON.stringify((await get(viewer, `/works/${shelf.workId}/history`).expect(200)).body)

    afterEach(async () => {
      await setHolderNames(owner, true).expect(200)
    })

    it('власник: імена є, гостьовий рядок анонімний, аліаса немає у відповіді друга', async () => {
      const body = workHistoryResponseSchema.parse(
        (await get(owner, `/works/${shelf.workId}/history`).expect(200)).body,
      )
      const byCopy = new Map(body.entries.map((item) => [item.copyId, item.entry]))

      expect(byCopy.get(copyOf('handed'))).toMatchObject({ names: true })
      expect(byCopy.get(copyOf('guest'))).toMatchObject({ names: false })
    })

    it('друг із showHolderNames = true: імена зареєстрованих, гість — анонімно, без alias/email/contactId', async () => {
      await setHolderNames(owner, true).expect(200)

      const raw = await rawWork(friend)
      const body = workHistoryResponseSchema.parse(JSON.parse(raw))
      const byCopy = new Map(body.entries.map((item) => [item.copyId, item.entry]))

      expect(byCopy.get(copyOf('handed'))).toMatchObject({ names: true })
      expect(byCopy.get(copyOf('guest'))).toEqual(expect.objectContaining({ names: false }))
      expect(byCopy.get(copyOf('guest'))).not.toHaveProperty('borrower')
      expect(raw).not.toContain(GUEST_ALIAS)

      for (const key of ['alias', 'email', 'contactId', 'borrowerContactId', 'heldByContactId']) {
        expect(raw).not.toContain(`"${key}"`)
      }
    })

    it('друг із showHolderNames = false: усе анонімно, у сирому тілі немає носіїв особи', async () => {
      await setHolderNames(owner, false).expect(200)

      const raw = await rawWork(friend)
      const body = workHistoryResponseSchema.parse(JSON.parse(raw))

      expect(body.entries).toHaveLength(READ_LABELS.length)
      expect(body.entries.every((item) => !item.entry.names)).toBe(true)

      for (const key of ['owner', 'borrower', 'loanId', 'displayName', 'email', 'alias']) {
        expect(raw).not.toContain(`"${key}"`)
      }

      expect(raw).not.toContain(borrower.displayName)
      expect(raw).not.toContain(GUEST_ALIAS)
    })

    it('сторонній: у «Хто читав» порожньо, /copies/:id/history — 404 (примірник FRIENDS невидимий стороннім)', async () => {
      expect(await workCopyIds(stranger)).toEqual([])

      const refused = await get(stranger, `/copies/${copyOf('handed')}/history`).expect(404)

      expect(apiErrorSchema.parse(refused.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
    })

    it('blocked: у «Хто читав» порожньо, /copies/:id/history — 403 FRIENDSHIP_BLOCKED', async () => {
      expect(await workCopyIds(blocked)).toEqual([])

      const refused = await get(blocked, `/copies/${copyOf('handed')}/history`).expect(403)

      expect(apiErrorSchema.parse(refused.body).code).toBe(API_ERROR_CODES.FRIENDSHIP_BLOCKED)
    })
  })

  describe('H4: PENDING_CONFIRMATION і DECLINED — лише сторонам позики', () => {
    it.each(['pending', 'declined'])(
      'друг власника не бачить «%s» ні в activity history примірника, ні в «Хто читав»',
      async (label) => {
        const response = await get(friend, `/copies/${copyOf(label)}/history`).expect(200)

        expect(copyHistoryResponseSchema.parse(response.body).entries).toEqual([])
        expect(await workCopyIds(friend)).not.toContain(copyOf(label))
      },
    )

    it.each([
      ['pending', 'PENDING_CONFIRMATION'],
      ['declined', 'DECLINED'],
    ])('власник і позичальник «%s» бачать запис у /copies/:id/history', async (label, status) => {
      for (const viewer of [owner, borrower]) {
        const response = await get(viewer, `/copies/${copyOf(label)}/history`).expect(200)

        expect(
          copyHistoryResponseSchema.parse(response.body).entries.map((entry) => entry.status),
        ).toEqual([status])
      }
    })

    it('чужі друзі не бачать претензій і в /me/history', async () => {
      const body = myHistoryResponseSchema.parse(
        (await get(friend, '/me/history').expect(200)).body,
      )

      expect(body.borrowed).toEqual([])
      expect(body.lent).toEqual([])
    })
  })
})
