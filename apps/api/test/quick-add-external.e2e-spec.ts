import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  quickAddResponseSchema,
  type BookLookupResult,
  type QuickAddResponse,
} from '@bookswap/shared'
import { BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/book-lookup-provider'
import type { GoogleVolumeRecord } from '../src/catalog/lookup/google-books-lookup-provider'
import { EXTERNAL_VOLUME_PROVIDER } from '../src/catalog/lookup/google-books-volume-provider'
import { CopyWriter } from '../src/library/copy-writer'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { beginRequest } from './concurrency.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'
import { FakeLookupProvider } from './lookup/fake-lookup-provider'
import { FakeVolumeProvider } from './lookup/fake-volume-provider'

/**
 * Швидке додавання, етап D (docs/plan/fast-book-add.md, QA2–QA6; ред. 2.1): ПЕРШЕ додавання зовнішнього видання
 * з неповними даними — одним запитом, атомарно, ідемпотентно, з правилами ідентичності.
 * Джерела — фейки, жодного реального HTTP (§11).
 */
describe('POST /me/library/quick-add — зовнішнє видання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  const volumes = new FakeVolumeProvider()
  const lookup = new FakeLookupProvider()
  const ORIGINAL_TIMEOUT = process.env.CATALOG_LOOKUP_TIMEOUT_MS

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_VOLUME_PROVIDER).useValue(volumes)
        builder.overrideProvider(BOOK_LOOKUP_PROVIDER).useValue(lookup)
      },
    })
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    volumes.clear()
    lookup.clear()

    if (ORIGINAL_TIMEOUT === undefined) delete process.env.CATALOG_LOOKUP_TIMEOUT_MS
    else process.env.CATALOG_LOOKUP_TIMEOUT_MS = ORIGINAL_TIMEOUT
  })

  afterAll(async () => {
    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  const token = (): string => `Ext${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const isbn = (): string => uniqueIsbn13('quick-add-external')

  function volume(
    id: string,
    over: Partial<BookLookupResult> & { isbn13?: string | undefined } = {},
  ): GoogleVolumeRecord {
    const { isbn13, ...result } = over

    return {
      externalId: id,
      ...(isbn13 === undefined ? {} : { isbn13 }),
      result: { title: token(), externalId: id, ...result },
    }
  }

  const post = (account: Account, body: unknown, target: INestApplication<App> = app) =>
    request(target.getHttpServer())
      .post(url('/me/library/quick-add'))
      .set('Cookie', account.cookie)
      .send(body as object)

  const gb = (externalId: string, isbn13?: string) => ({
    kind: 'EXTERNAL_EDITION',
    source: 'GOOGLE_BOOKS',
    externalId,
    ...(isbn13 === undefined ? {} : { isbn13 }),
  })

  async function added(
    account: Account,
    target: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<QuickAddResponse> {
    const response = await post(account, { operationId: randomUUID(), target, ...extra }).expect(
      201,
    )

    return quickAddResponseSchema.parse(response.body)
  }

  const referenceOf = (externalId: string) =>
    prisma.editionExternalReference.findUnique({
      where: { source_externalId: { source: 'GOOGLE_BOOKS', externalId } },
    })

  async function localEdition(account: Account, number: string): Promise<string> {
    const work = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', account.cookie)
      .send({ title: token(), origLang: 'en', authors: [{ name: token() }] })
      .expect(201)
    const edition = await request(app.getHttpServer())
      .post(url(`/works/${(work.body as { work: { id: string } }).work.id}/editions`))
      .set('Cookie', account.cookie)
      .send({ isbn13: number })
      .expect(201)

    return (edition.body as { edition: { id: string } }).edition.id
  }

  describe('перше додавання з неповними даними (QA2)', () => {
    it('том лише з назвою й id: один запит — Work без автора й мови, Edition із невідомим, один Copy', async () => {
      const user = await registerAccount(app, 'ext-bare')
      const record = volume('gb-bare')

      volumes.respondWith('gb-bare', record)

      const result = await added(user, gb('gb-bare'))
      const edition = await prisma.edition.findUniqueOrThrow({
        where: { id: result.edition.id },
        include: { work: { include: { authors: true } }, copies: true },
      })

      expect(result.replayed).toBe(false)
      expect(result.edition).toMatchObject({
        textKind: 'UNKNOWN',
        lang: null,
        format: null,
        isbn13: null,
      })
      expect(result.work).toMatchObject({
        title: record.result.title,
        origLang: null,
        firstPubYear: null,
      })
      expect(result.authors).toEqual([])
      expect(edition).toMatchObject({
        textKind: 'UNKNOWN',
        lang: null,
        format: null,
        translationId: null,
        createdById: user.id,
      })
      expect(edition.work.authors).toHaveLength(0)
      expect(edition.copies).toHaveLength(1)
      expect(edition.copies[0]).toMatchObject({ ownerId: user.id, currentHolderId: user.id })
      expect((await referenceOf('gb-bare'))?.editionId).toBe(edition.id)
    })

    it('повні дані: автори в порядку джерела, мова — мова ВИДАННЯ, рік видання не стає роком твору', async () => {
      const user = await registerAccount(app, 'ext-rich')
      const number = isbn()

      volumes.respondWith(
        'gb-rich',
        volume('gb-rich', {
          isbn13: number,
          authors: ['Перший Автор', 'Другий Автор'],
          language: 'uk',
          publisher: 'Видавець',
          publishedYear: 2021,
          pageCount: 321,
          coverUrl: 'https://books.google.com/cover.jpg',
          description: 'Опис книжки',
        }),
      )

      const result = await added(user, gb('gb-rich', number))
      const stored = await prisma.work.findUniqueOrThrow({
        where: { id: result.work.id },
        include: { authors: { include: { author: true }, orderBy: { position: 'asc' } } },
      })

      expect(result.edition).toMatchObject({
        isbn13: number,
        lang: 'uk',
        textKind: 'UNKNOWN',
        publisher: 'Видавець',
        year: 2021,
        pageCount: 321,
        coverUrl: 'https://books.google.com/cover.jpg',
        format: null,
      })
      expect(stored).toMatchObject({
        origLang: null,
        firstPubYear: null,
        description: 'Опис книжки',
      })
      expect(stored.authors.map((link) => [link.author.name, link.role, link.position])).toEqual([
        ['Перший Автор', 'AUTHOR', 0],
        ['Другий Автор', 'AUTHOR', 1],
      ])
    })

    it('точний ISBN без id тому: метадані з ISBN-пошуку, посилання — підтверджена пара джерела', async () => {
      const user = await registerAccount(app, 'ext-isbn')
      const number = isbn()

      lookup.respondWith(number, {
        title: token(),
        authors: ['Автор'],
        format: 'HARDCOVER',
        source: 'GOOGLE_BOOKS',
        externalId: 'gb-by-isbn',
      })

      const result = await added(user, { kind: 'EXTERNAL_EDITION', isbn13: number })

      expect(result.edition).toMatchObject({
        isbn13: number,
        format: 'HARDCOVER',
        textKind: 'UNKNOWN',
      })
      expect((await referenceOf('gb-by-isbn'))?.editionId).toBe(result.edition.id)
    })

    it('ISBN, названий клієнтом, але не підтверджений томом, не використовується', async () => {
      const user = await registerAccount(app, 'ext-unconfirmed')

      volumes.respondWith('gb-no-isbn', volume('gb-no-isbn'))

      const result = await added(user, gb('gb-no-isbn', isbn()))

      expect(result.edition.isbn13).toBeNull()
    })

    it('ISBN клієнта, що суперечить тому, — 422, нічого не створено', async () => {
      const user = await registerAccount(app, 'ext-mismatch')

      volumes.respondWith('gb-mismatch', volume('gb-mismatch', { isbn13: isbn() }))

      const body = { operationId: randomUUID(), target: gb('gb-mismatch', isbn()) }
      const response = await post(user, body).expect(422)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      expect(await referenceOf('gb-mismatch')).toBeNull()
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)
    })
  })

  describe('джерело недоступне', () => {
    it.each([
      ['таймаут', 504, API_ERROR_CODES.CATALOG_LOOKUP_TIMEOUT],
      ['помилка провайдера', 502, API_ERROR_CODES.CATALOG_LOOKUP_PROVIDER_ERROR],
      ['немає такого тому', 404, API_ERROR_CODES.CATALOG_LOOKUP_NOT_FOUND],
    ] as const)('%s — чинний код, нічого не записано', async (kind, status, code) => {
      const user = await registerAccount(app, 'ext-down')
      const id = `gb-down-${randomUUID().slice(0, 8)}`

      if (kind === 'таймаут') {
        process.env.CATALOG_LOOKUP_TIMEOUT_MS = '60'
        volumes.hang(id)
      } else if (kind === 'помилка провайдера') volumes.respondWithError(id)
      else volumes.respondNotFound(id)

      const body = { operationId: randomUUID(), target: gb(id) }
      const response = await post(user, body).expect(status)

      expect(apiErrorSchema.parse(response.body).code).toBe(code)
      expect(await referenceOf(id)).toBeNull()
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(0)
    })

    it('після збою той самий намір спрацьовує з тим самим operationId', async () => {
      const user = await registerAccount(app, 'ext-recover')
      const id = `gb-recover-${randomUUID().slice(0, 8)}`
      const body = { operationId: randomUUID(), target: gb(id) }

      volumes.respondWithError(id)
      await post(user, body).expect(502)
      volumes.respondWith(id, volume(id))

      const result = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)

      expect(result.replayed).toBe(false)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(1)
    })
  })

  describe('локальне видання — без мережі (ред. 2.1, правка 3)', () => {
    it('видання вже є за ISBN: провайдер недоступний, але додавання успішне й посилання з клієнтського id НЕ створюється', async () => {
      const owner = await registerAccount(app, 'ext-local-owner')
      const reader = await registerAccount(app, 'ext-local-reader')
      const number = isbn()
      const existing = await localEdition(owner, number)

      volumes.hang('gb-local-isbn')

      const result = await added(reader, gb('gb-local-isbn', number))

      expect(result.edition.id).toBe(existing)
      expect(volumes.calls).toEqual([])
      // Підтвердження немає (мережі не було), а слова клієнта посиланням не стають.
      expect(await referenceOf('gb-local-isbn')).toBeNull()
    })

    it('видання вже відоме за підтвердженим посиланням: інший користувач додає без мережі, нового Work немає', async () => {
      const first = await registerAccount(app, 'ext-ref-first')
      const second = await registerAccount(app, 'ext-ref-second')

      volumes.respondWith('gb-shared', volume('gb-shared'))

      const one = await added(first, gb('gb-shared'))

      volumes.clear()
      volumes.hang('gb-shared')

      const two = await added(second, gb('gb-shared'))

      expect(two.edition.id).toBe(one.edition.id)
      expect(volumes.calls).toEqual([])
      expect(await prisma.work.count({ where: { id: one.work.id } })).toBe(1)
      expect(await prisma.copy.count({ where: { editionId: one.edition.id } })).toBe(2)
    })
  })

  describe('суперечливі ідентифікатори (ред. 2.1, §6a)', () => {
    it('ISBN → одне видання, посилання → інше: явний конфлікт, Copy не створено, посилання не перепривʼязано', async () => {
      const owner = await registerAccount(app, 'ext-conflict')
      const number = isbn()
      const byIsbn = await localEdition(owner, number)
      const byReference = await localEdition(owner, isbn())

      await prisma.editionExternalReference.create({
        data: { source: 'GOOGLE_BOOKS', externalId: 'gb-conflict', editionId: byReference },
      })

      const body = { operationId: randomUUID(), target: gb('gb-conflict', number) }
      const response = await post(owner, body).expect(409)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.EXTERNAL_IDENTITY_CONFLICT)
      expect(error.details).toMatchObject({
        isbnEditionId: byIsbn,
        referenceEditionId: byReference,
      })
      expect(await prisma.copy.count({ where: { ownerId: owner.id } })).toBe(0)
      expect((await referenceOf('gb-conflict'))?.editionId).toBe(byReference)
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)
    })

    it('підтверджений ISBN тому суперечить видання, на яке вже вказує посилання, — конфлікт', async () => {
      const owner = await registerAccount(app, 'ext-conflict-isbn')
      const other = await localEdition(owner, isbn())
      const confirmedIsbn = isbn()

      await prisma.editionExternalReference.create({
        data: { source: 'GOOGLE_BOOKS', externalId: 'gb-contradict', editionId: other },
      })
      volumes.respondWith('gb-contradict', volume('gb-contradict', { isbn13: confirmedIsbn }))

      // Клієнт називає лише ISBN нового видання й посилання: пошук знаходить `other` за посиланням, але ISBN
      // в нього інший — це не «те саме видання».
      const response = await post(owner, {
        operationId: randomUUID(),
        target: gb('gb-contradict', confirmedIsbn),
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EXTERNAL_IDENTITY_CONFLICT,
      )
      expect(await prisma.copy.count({ where: { ownerId: owner.id } })).toBe(0)
    })
  })

  describe('змагання й повтори (QA4, QA5)', () => {
    it('двоє користувачів додають один новий ISBN одночасно: одне Edition, два незалежні Copy, одне посилання', async () => {
      const one = await registerAccount(app, 'ext-race-a')
      const two = await registerAccount(app, 'ext-race-b')
      const number = isbn()

      volumes.respondWith('gb-race', volume('gb-race', { isbn13: number }))

      // Обидва вже отримали метадані й жоден ще не почав транзакцію.
      const release = volumes.holdResponses()
      const first = beginRequest(
        post(one, { operationId: randomUUID(), target: gb('gb-race', number) }),
      )
      const second = beginRequest(
        post(two, { operationId: randomUUID(), target: gb('gb-race', number) }),
      )

      while (volumes.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))

      release()

      const [a, b] = await Promise.all([first, second])

      expect([a.status, b.status]).toEqual([201, 201])

      const results = [a, b].map((response) => quickAddResponseSchema.parse(response.body))

      expect(results[0]?.edition.id).toBe(results[1]?.edition.id)
      expect(await prisma.edition.count({ where: { isbn13: number } })).toBe(1)
      expect(await prisma.copy.count({ where: { editionId: results[0]?.edition.id } })).toBe(2)
      expect(
        await prisma.copy.count({ where: { editionId: results[0]?.edition.id, ownerId: one.id } }),
      ).toBe(1)
      expect(
        await prisma.editionExternalReference.count({ where: { externalId: 'gb-race' } }),
      ).toBe(1)
      expect(await prisma.work.count({ where: { id: results[0]?.work.id } })).toBe(1)
    })

    it('підтверджене посилання зберігається й тоді, коли видання знайдено за ISBN уже всередині транзакції', async () => {
      const one = await registerAccount(app, 'ext-late-a')
      const two = await registerAccount(app, 'ext-late-b')
      const number = isbn()

      lookup.respondWith(number, { title: token(), source: 'OPEN_LIBRARY', externalId: 'OL1M' })
      volumes.respondWith('gb-late', volume('gb-late', { isbn13: number }))

      const release = volumes.holdResponses()
      const waiting = beginRequest(
        post(two, { operationId: randomUUID(), target: gb('gb-late', number) }),
      )

      while (volumes.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 10))

      // Поки другий чекає на джерело, перший створює те саме видання іншим шляхом.
      const first = await added(one, { kind: 'EXTERNAL_EDITION', isbn13: number })

      release()

      const second = quickAddResponseSchema.parse((await waiting).body)

      expect(second.edition.id).toBe(first.edition.id)
      expect((await referenceOf('gb-late'))?.editionId).toBe(first.edition.id)
      expect(
        (
          await prisma.editionExternalReference.findUnique({
            where: { source_externalId: { source: 'OPEN_LIBRARY', externalId: 'OL1M' } },
          })
        )?.editionId,
      ).toBe(first.edition.id)
    })

    it('вісім паралельних повторів тієї самої дії: один Work, одне Edition, один Copy', async () => {
      const user = await registerAccount(app, 'ext-double')
      const id = `gb-double-${randomUUID().slice(0, 8)}`
      const body = { operationId: randomUUID(), target: gb(id) }

      volumes.respondWith(id, volume(id))

      const responses = await Promise.all(Array.from({ length: 8 }, () => post(user, body)))

      expect(responses.map((response) => response.status)).toEqual(Array(8).fill(201))

      const results = responses.map((response) => quickAddResponseSchema.parse(response.body))

      expect(new Set(results.map((result) => result.copy.id)).size).toBe(1)
      expect(new Set(results.map((result) => result.work.id)).size).toBe(1)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(1)
      expect((await referenceOf(id))?.editionId).toBe(results[0]?.edition.id)
    })

    it('повтор після «рестарту» не звертається до джерела й повертає той самий примірник', async () => {
      const user = await registerAccount(app, 'ext-restart')
      const id = `gb-restart-${randomUUID().slice(0, 8)}`
      const body = { operationId: randomUUID(), target: gb(id) }

      volumes.respondWith(id, volume(id))

      const first = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)
      const restarted = await createTestApp({
        configure: (builder) => {
          builder.overrideProvider(EXTERNAL_VOLUME_PROVIDER).useValue(volumes)
          builder.overrideProvider(BOOK_LOOKUP_PROVIDER).useValue(lookup)
        },
      })

      volumes.clear()
      volumes.hang(id)

      try {
        const again = quickAddResponseSchema.parse(
          (await post(user, body, restarted).expect(201)).body,
        )

        expect(again).toMatchObject({ replayed: true })
        expect(again.copy.id).toBe(first.copy.id)
        expect(volumes.calls).toEqual([])
      } finally {
        await restarted.close()
      }
    })

    it('інший вміст з тим самим operationId — 409 і без звернення до джерела', async () => {
      const user = await registerAccount(app, 'ext-op-conflict')
      const id = `gb-opc-${randomUUID().slice(0, 8)}`
      const operationId = randomUUID()

      volumes.respondWith(id, volume(id))
      await post(user, { operationId, target: gb(id) }).expect(201)
      volumes.clear()

      const response = await post(user, {
        operationId,
        target: gb(id),
        copy: { condition: 'WORN' },
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.LIBRARY_ADD_OPERATION_CONFLICT,
      )
    })

    it('свідоме «ще один примірник» зовнішнього видання — нова операція, те саме Edition', async () => {
      const user = await registerAccount(app, 'ext-second')
      const id = `gb-second-${randomUUID().slice(0, 8)}`

      volumes.respondWith(id, volume(id))

      const first = await added(user, gb(id))
      const second = await added(user, gb(id))

      expect(second.edition.id).toBe(first.edition.id)
      expect(second.copy.id).not.toBe(first.copy.id)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(2)
    })
  })

  describe('атомарність (QA3)', () => {
    it('помилка після створення Copy відкочує нові Work, Author, Edition, посилання й операцію', async () => {
      const user = await registerAccount(app, 'ext-rollback')
      const number = isbn()
      const title = token()
      const authorName = `Відкат ${token()}`
      const real = new CopyWriter()
      const failing = await createTestApp({
        configure: (builder) => {
          builder.overrideProvider(EXTERNAL_VOLUME_PROVIDER).useValue(volumes)
          builder.overrideProvider(BOOK_LOOKUP_PROVIDER).useValue(lookup)
          builder.overrideProvider(CopyWriter).useValue({
            create: async (...args: Parameters<CopyWriter['create']>) => {
              await real.create(...args)

              throw new Error('примусова помилка після запису Copy')
            },
          })
        },
      })
      const body = { operationId: randomUUID(), target: gb('gb-rollback', number) }

      volumes.respondWith(
        'gb-rollback',
        volume('gb-rollback', { isbn13: number, authors: [authorName], title }),
      )

      try {
        await post(user, body, failing).expect(500)
      } finally {
        await failing.close()
      }

      expect(await prisma.work.count({ where: { title } })).toBe(0)
      expect(await prisma.author.count({ where: { name: authorName } })).toBe(0)
      expect(await prisma.edition.count({ where: { isbn13: number } })).toBe(0)
      expect(await referenceOf('gb-rollback')).toBeNull()
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(0)

      const retried = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)

      expect(retried.replayed).toBe(false)
      expect(await prisma.work.count({ where: { title } })).toBe(1)
    })
  })

  describe('наслідки для решти системи', () => {
    it('нове видання видно в каталозі й у бібліотеці власника; BOOK_ADDED записано один раз', async () => {
      const user = await registerAccount(app, 'ext-after')
      const id = `gb-after-${randomUUID().slice(0, 8)}`

      volumes.respondWith(id, volume(id, { language: 'pl' }))

      const result = await added(user, gb(id), { entryMethod: 'BARCODE' })
      const library = await request(app.getHttpServer())
        .get(url('/me/library?lang=pl'))
        .set('Cookie', user.cookie)
        .expect(200)

      expect(
        (library.body as { groups: { edition: { id: string } }[] }).groups.map(
          (group) => group.edition.id,
        ),
      ).toEqual([result.edition.id])
      expect(
        await prisma.productEvent.count({ where: { subjectUserId: user.id, type: 'BOOK_ADDED' } }),
      ).toBe(1)
    })

    it('додавання без жодної ідентичності чи з чужим джерелом відхиляється валідацією', async () => {
      const user = await registerAccount(app, 'ext-invalid')

      for (const target of [
        { kind: 'EXTERNAL_EDITION' },
        { kind: 'EXTERNAL_EDITION', source: 'GOOGLE_BOOKS' },
        { kind: 'EXTERNAL_EDITION', externalId: 'x' },
        { kind: 'EXTERNAL_EDITION', source: 'OPEN_LIBRARY', externalId: 'x' },
        { kind: 'EXTERNAL_EDITION', isbn13: '1234567890123' },
        { kind: 'EXTERNAL_EDITION', isbn13: isbn(), title: 'довільна назва' },
      ]) {
        const response = await post(user, { operationId: randomUUID(), target }).expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }
    })
  })
})
