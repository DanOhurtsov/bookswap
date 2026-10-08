import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  quickAddResponseSchema,
  type QuickAddResponse,
  type Visibility,
} from '@bookswap/shared'
import { computeDedupeKey } from '../src/analytics/dedupe-key'
import { AnalyticsService } from '../src/analytics/analytics.service'
import { CopyWriter } from '../src/library/copy-writer'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { registerAccount, url } from './loan.helpers'

/**
 * Швидке додавання, етап A (docs/plan/fast-book-add.md, QA1, QA4, QA7, QA12): `POST /me/library/quick-add`
 * для видання, що вже є в каталозі. Ідемпотентність перевіряється на рівні БД — другим застосунком
 * над тією самою базою (рестарт процесу), а не лише повтором у межах одного.
 */
describe('POST /me/library/quick-add — наявне видання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  let sequence = 0

  /** Видання без жодного примірника: ланцюг Work → Edition через справжній API. */
  async function createEdition(owner: { cookie: string }): Promise<string> {
    sequence += 1

    const token = `${String(process.pid)}-${String(sequence)}`
    const work = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', owner.cookie)
      .send({
        title: `Швидка полиця ${token}`,
        origLang: 'en',
        authors: [{ name: `Швидкий автор ${token}` }],
      })
      .expect(201)
    const edition = await request(app.getHttpServer())
      .post(url(`/works/${(work.body as { work: { id: string } }).work.id}/editions`))
      .set('Cookie', owner.cookie)
      .send({ publisher: 'КСД', year: 2019 })
      .expect(201)

    return (edition.body as { edition: { id: string } }).edition.id
  }

  function body(editionId: string, extra: Record<string, unknown> = {}) {
    return {
      operationId: randomUUID(),
      target: { kind: 'EXISTING_EDITION', editionId },
      ...extra,
    }
  }

  function quickAdd(
    target: INestApplication<App>,
    account: { cookie: string },
    payload: unknown,
  ): request.Test {
    return request(target.getHttpServer())
      .post(url('/me/library/quick-add'))
      .set('Cookie', account.cookie)
      .send(payload as object)
  }

  async function added(
    target: INestApplication<App>,
    account: { cookie: string },
    payload: unknown,
    status = 201,
  ): Promise<QuickAddResponse> {
    const response = await quickAdd(target, account, payload).expect(status)

    return quickAddResponseSchema.parse(response.body)
  }

  const copiesOf = (ownerId: string, editionId: string) =>
    prisma.copy.count({ where: { ownerId, editionId } })

  describe('одне натискання (QA1)', () => {
    it('створює рівно один примірник: власник і тримач — користувач із сесії', async () => {
      const owner = await registerAccount(app, 'qa-one')
      const editionId = await createEdition(owner)
      const reader = await registerAccount(app, 'qa-reader')

      const result = await added(app, reader, body(editionId))

      expect(result.replayed).toBe(false)
      expect(result.edition.id).toBe(editionId)
      expect(result.work.id).toBe(result.edition.workId)
      expect(result.authors).toHaveLength(1)
      expect(result.copy).toMatchObject({ status: 'AVAILABLE', condition: 'GOOD', isHome: true })

      const row = await prisma.copy.findUniqueOrThrow({ where: { id: result.copy.id } })

      expect(row).toMatchObject({
        ownerId: reader.id,
        currentHolderId: reader.id,
        editionId,
        archivedAt: null,
      })
      expect(await copiesOf(reader.id, editionId)).toBe(1)
      expect(await copiesOf(owner.id, editionId)).toBe(0)
    })

    it('приймає персональні значення примірника', async () => {
      const owner = await registerAccount(app, 'qa-values')
      const editionId = await createEdition(owner)

      const result = await added(
        app,
        owner,
        body(editionId, {
          entryMethod: 'BARCODE',
          copy: {
            condition: 'WORN',
            visibility: 'PRIVATE',
            note: '  з плямою  ',
            acquiredAt: '2026-03-01',
          },
        }),
      )

      expect(result.copy).toMatchObject({
        condition: 'WORN',
        visibility: 'PRIVATE',
        note: 'з плямою',
        acquiredAt: '2026-03-01',
      })
    })

    it('невідоме видання — 404 без запису операції', async () => {
      const owner = await registerAccount(app, 'qa-404')
      const payload = body('no-such-edition')
      const response = await quickAdd(app, owner, payload).expect(404)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.NOT_FOUND)
      expect(
        await prisma.libraryAddOperation.count({
          where: { userId: owner.id, operationId: payload.operationId },
        }),
      ).toBe(0)
    })
  })

  describe('ідемпотентність (QA4)', () => {
    it('повтор того самого запиту повертає той самий примірник і не додає новий', async () => {
      const owner = await registerAccount(app, 'qa-replay')
      const editionId = await createEdition(owner)
      const payload = body(editionId, { copy: { note: 'моя' } })

      const first = await added(app, owner, payload)
      const second = await added(app, owner, payload)
      const third = await added(app, owner, payload)

      expect(first.replayed).toBe(false)
      expect([second.replayed, third.replayed]).toEqual([true, true])
      expect(second.copy.id).toBe(first.copy.id)
      expect(third.copy.id).toBe(first.copy.id)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
    })

    it('одночасні дублікати (подвійний клік) створюють один примірник', async () => {
      const owner = await registerAccount(app, 'qa-race')
      const editionId = await createEdition(owner)
      const payload = body(editionId)

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          quickAdd(app, owner, payload).then((response) => {
            expect(response.status).toBe(201)

            return quickAddResponseSchema.parse(response.body)
          }),
        ),
      )

      expect(new Set(results.map((result) => result.copy.id)).size).toBe(1)
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
      expect(
        await prisma.libraryAddOperation.count({
          where: { userId: owner.id, operationId: payload.operationId },
        }),
      ).toBe(1)
    })

    it('повтор після «рестарту» (новий застосунок над тією самою базою) — той самий примірник', async () => {
      const owner = await registerAccount(app, 'qa-restart')
      const editionId = await createEdition(owner)
      const payload = body(editionId)
      const first = await added(app, owner, payload)
      const restarted = await createTestApp()

      try {
        const again = await added(restarted, owner, payload)

        expect(again.replayed).toBe(true)
        expect(again.copy.id).toBe(first.copy.id)
        expect(await copiesOf(owner.id, editionId)).toBe(1)
      } finally {
        await restarted.close()
      }
    })

    it('той самий operationId з іншим вмістом — 409 і нового примірника немає', async () => {
      const owner = await registerAccount(app, 'qa-conflict')
      const editionId = await createEdition(owner)
      const otherEditionId = await createEdition(owner)
      const payload = body(editionId)

      await added(app, owner, payload)

      for (const changed of [
        { ...payload, copy: { condition: 'WORN' } },
        { ...payload, target: { kind: 'EXISTING_EDITION', editionId: otherEditionId } },
        { ...payload, entryMethod: 'BARCODE' },
      ]) {
        const response = await quickAdd(app, owner, changed).expect(409)

        expect(apiErrorSchema.parse(response.body).code).toBe(
          API_ERROR_CODES.LIBRARY_ADD_OPERATION_CONFLICT,
        )
      }

      expect(await copiesOf(owner.id, editionId)).toBe(1)
      expect(await copiesOf(owner.id, otherEditionId)).toBe(0)
    })

    it('форма запису не робить ту саму дію «іншою» (порядок ключів, null замість відсутнього)', async () => {
      const owner = await registerAccount(app, 'qa-canonical')
      const editionId = await createEdition(owner)
      const operationId = randomUUID()

      const first = await added(app, owner, {
        operationId,
        target: { editionId, kind: 'EXISTING_EDITION' },
        copy: { condition: 'GOOD' },
      })
      const second = await added(app, owner, {
        operationId,
        entryMethod: 'MANUAL',
        copy: { condition: 'GOOD', note: null },
        target: { kind: 'EXISTING_EDITION', editionId },
      })

      expect(second.replayed).toBe(true)
      expect(second.copy.id).toBe(first.copy.id)
    })

    it('свідоме «ще один примірник» — новий operationId і другий Copy', async () => {
      const owner = await registerAccount(app, 'qa-second')
      const editionId = await createEdition(owner)

      const first = await added(app, owner, body(editionId))
      const second = await added(app, owner, body(editionId))

      expect(second.replayed).toBe(false)
      expect(second.copy.id).not.toBe(first.copy.id)
      expect(await copiesOf(owner.id, editionId)).toBe(2)
    })

    it('ключі різних користувачів не перетинаються', async () => {
      const owner = await registerAccount(app, 'qa-scope-a')
      const other = await registerAccount(app, 'qa-scope-b')
      const editionId = await createEdition(owner)
      const payload = body(editionId)

      const mine = await added(app, owner, payload)
      const theirs = await added(app, other, payload)

      expect(theirs.replayed).toBe(false)
      expect(theirs.copy.id).not.toBe(mine.copy.id)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
      expect(await copiesOf(other.id, editionId)).toBe(1)
    })

    it('повтор після видалення примірника не відновлює його', async () => {
      const owner = await registerAccount(app, 'qa-removed')
      const editionId = await createEdition(owner)
      const payload = body(editionId)
      const first = await added(app, owner, payload)

      await request(app.getHttpServer())
        .delete(url(`/me/library/${first.copy.id}`))
        .set('Cookie', owner.cookie)
        .expect(204)

      const response = await quickAdd(app, owner, payload).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.LIBRARY_ADD_RESULT_REMOVED,
      )
      expect(await copiesOf(owner.id, editionId)).toBe(0)

      const fresh = await added(app, owner, body(editionId))

      expect(fresh.replayed).toBe(false)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
    })

    it('не лишає в БД нічого, крім відбитка: нотатка в запис операції не потрапляє', async () => {
      const owner = await registerAccount(app, 'qa-note')
      const editionId = await createEdition(owner)
      const payload = body(editionId, { copy: { note: 'ПРИВАТНА-НОТАТКА-ТЕСТ' } })

      await added(app, owner, payload)

      const operation = await prisma.libraryAddOperation.findUniqueOrThrow({
        where: { userId_operationId: { userId: owner.id, operationId: payload.operationId } },
      })

      expect(JSON.stringify(operation)).not.toContain('ПРИВАТНА-НОТАТКА-ТЕСТ')
      expect(operation).toMatchObject({ targetKind: 'EXISTING_EDITION', editionId })
    })
  })

  describe('атомарність', () => {
    it('помилка після створення Copy відкочує і Copy, і запис операції; повтор спрацьовує', async () => {
      const owner = await registerAccount(app, 'qa-rollback')
      const editionId = await createEdition(owner)
      const real = new CopyWriter()
      const failing = await createTestApp({
        configure: (builder) =>
          builder.overrideProvider(CopyWriter).useValue({
            create: async (...args: Parameters<CopyWriter['create']>) => {
              await real.create(...args)

              throw new Error('примусова помилка після запису Copy')
            },
          }),
      })
      const payload = body(editionId)

      try {
        await quickAdd(failing, owner, payload).expect(500)
      } finally {
        await failing.close()
      }

      expect(await copiesOf(owner.id, editionId)).toBe(0)
      expect(
        await prisma.libraryAddOperation.count({
          where: { userId: owner.id, operationId: payload.operationId },
        }),
      ).toBe(0)

      const retried = await added(app, owner, payload)

      expect(retried.replayed).toBe(false)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
    })
  })

  describe('видимість за замовчуванням (QA7)', () => {
    it.each<[Visibility, Visibility]>([
      ['PRIVATE', 'PRIVATE'],
      ['FRIENDS', 'FRIENDS'],
      ['PUBLIC', 'FRIENDS'],
    ])('профіль %s без явного вибору → примірник %s', async (library, expected) => {
      const owner = await registerAccount(app, `qa-vis-${library.toLowerCase()}`)
      const editionId = await createEdition(owner)

      await prisma.user.update({ where: { id: owner.id }, data: { libraryVisibility: library } })

      const result = await added(app, owner, body(editionId))

      expect(result.copy.visibility).toBe(expected)
    })

    it('явно задана видимість зберігається', async () => {
      const owner = await registerAccount(app, 'qa-vis-explicit')
      const editionId = await createEdition(owner)

      await prisma.user.update({ where: { id: owner.id }, data: { libraryVisibility: 'PUBLIC' } })

      const result = await added(app, owner, body(editionId, { copy: { visibility: 'PUBLIC' } }))

      expect(result.copy.visibility).toBe('PUBLIC')
    })

    it('старий POST /me/library отримує той самий серверний дефолт', async () => {
      const owner = await registerAccount(app, 'qa-vis-legacy')
      const editionId = await createEdition(owner)

      await prisma.user.update({ where: { id: owner.id }, data: { libraryVisibility: 'PRIVATE' } })

      const response = await request(app.getHttpServer())
        .post(url('/me/library'))
        .set('Cookie', owner.cookie)
        .send({ editionId })
        .expect(201)

      expect((response.body as { copy: { visibility: string } }).copy.visibility).toBe('PRIVATE')
    })

    it('власник береться лише з сесії: чужий ownerId у запиті відхиляється', async () => {
      const owner = await registerAccount(app, 'qa-owner')
      const victim = await registerAccount(app, 'qa-victim')
      const editionId = await createEdition(owner)

      const response = await quickAdd(app, owner, {
        ...body(editionId),
        ownerId: victim.id,
      }).expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect(await copiesOf(victim.id, editionId)).toBe(0)
      expect(await copiesOf(owner.id, editionId)).toBe(0)
    })
  })

  describe('валідація й доступ', () => {
    it('без сесії — 401', async () => {
      const response = await request(app.getHttpServer())
        .post(url('/me/library/quick-add'))
        .send(body('x'))
        .expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })

    it.each<[string, (editionId: string) => unknown]>([
      ['operationId не UUID', (editionId) => ({ ...body(editionId), operationId: 'не-uuid' })],
      ['немає operationId', (editionId) => ({ target: { kind: 'EXISTING_EDITION', editionId } })],
      ['немає target', () => ({ operationId: randomUUID() })],
      ['невідомий kind', () => ({ operationId: randomUUID(), target: { kind: 'SOMETHING' } })],
      [
        'зайве поле в target',
        (editionId) => ({
          operationId: randomUUID(),
          target: { kind: 'EXISTING_EDITION', editionId, isbn13: '9780000000002' },
        }),
      ],
      ['порожній editionId', () => body('   ')],
      ['невідома видимість', (editionId) => body(editionId, { copy: { visibility: 'SECRET' } })],
      ['зайве поле в copy', (editionId) => body(editionId, { copy: { status: 'LENT_OUT' } })],
      ['невалідна дата', (editionId) => body(editionId, { copy: { acquiredAt: '2026-13-40' } })],
    ])('%s — 400 VALIDATION_ERROR', async (_name, make) => {
      const owner = await registerAccount(app, 'qa-invalid')
      const editionId = await createEdition(owner)

      const response = await quickAdd(app, owner, make(editionId)).expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect(await copiesOf(owner.id, editionId)).toBe(0)
    })
  })

  describe('аналітика після commit (QA12)', () => {
    const eventsOf = (userId: string, copyId: string) =>
      prisma.productEvent.findMany({
        where: { dedupeKey: computeDedupeKey('BOOK_ADDED', copyId, userId) },
      })

    it('одна подія BOOK_ADDED на примірник; повтори її не множать; метод береться з запиту', async () => {
      const owner = await registerAccount(app, 'qa-event')
      const editionId = await createEdition(owner)
      const payload = body(editionId, { entryMethod: 'BARCODE' })

      const first = await added(app, owner, payload)

      await added(app, owner, payload)
      await added(app, owner, payload)

      const events = await eventsOf(owner.id, first.copy.id)

      expect(events).toHaveLength(1)
      expect(events[0]?.properties).toEqual({ method: 'BARCODE' })
    })

    it('збій аналітики не скасовує збереження; повтор дозаписує подію, якої бракувало', async () => {
      const owner = await registerAccount(app, 'qa-event-fail')
      const editionId = await createEdition(owner)
      const payload = body(editionId)
      const broken = await createTestApp({
        configure: (builder) =>
          builder.overrideProvider(AnalyticsService).useValue({
            record: () => Promise.reject(new Error('аналітика недоступна')),
          }),
      })
      let first: QuickAddResponse

      try {
        first = await added(broken, owner, payload)
      } finally {
        await broken.close()
      }

      expect(first.replayed).toBe(false)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
      expect(await eventsOf(owner.id, first.copy.id)).toHaveLength(0)

      const again = await added(app, owner, payload)

      expect(again.replayed).toBe(true)
      expect(again.copy.id).toBe(first.copy.id)
      expect(await eventsOf(owner.id, first.copy.id)).toHaveLength(1)
      expect(await copiesOf(owner.id, editionId)).toBe(1)
    })
  })
})
