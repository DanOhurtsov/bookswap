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
} from '@bookswap/shared'
import { CopyWriter } from '../src/library/copy-writer'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'

/**
 * Швидке додавання, етап E (docs/plan/fast-book-add.md, §2.4, QA9; ред. 2): ручне створення ОДНІЄЮ формою.
 * Обов'язкова лише назва; невідоме лишається невідомим; твір, переклад, видання й примірник — атомарно.
 */
describe('POST /me/library/quick-add — вручну (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  const token = (): string => `Man${randomUUID().replaceAll('-', '').slice(0, 12)}`

  const post = (account: Account, body: unknown, target: INestApplication<App> = app) =>
    request(target.getHttpServer())
      .post(url('/me/library/quick-add'))
      .set('Cookie', account.cookie)
      .send(body as object)

  function manual(
    work: Record<string, unknown>,
    edition: Record<string, unknown> = { textKind: 'UNKNOWN' },
    translation?: Record<string, unknown>,
  ) {
    return {
      kind: 'MANUAL',
      work,
      edition,
      ...(translation === undefined ? {} : { translation }),
    }
  }

  async function added(account: Account, target: unknown): Promise<QuickAddResponse> {
    const response = await post(account, { operationId: randomUUID(), target }).expect(201)

    return quickAddResponseSchema.parse(response.body)
  }

  describe('мінімальна форма', () => {
    it('лише назва: Work без автора й мови, Edition із невідомим текстом, один Copy', async () => {
      const user = await registerAccount(app, 'man-min')
      const title = token()
      const result = await added(user, manual({ title }))
      const stored = await prisma.edition.findUniqueOrThrow({
        where: { id: result.edition.id },
        include: { work: { include: { authors: true } }, copies: true },
      })

      expect(result.edition).toMatchObject({
        textKind: 'UNKNOWN',
        lang: null,
        format: null,
        isbn13: null,
        publisher: null,
        translationId: null,
      })
      expect(result.work).toMatchObject({ title, origLang: null, firstPubYear: null })
      expect(stored.work.authors).toHaveLength(0)
      expect(stored.createdById).toBe(user.id)
      expect(stored.copies).toHaveLength(1)
      expect(stored.copies[0]).toMatchObject({ ownerId: user.id, currentHolderId: user.id })
    })

    it('повна форма: автори в порядку, ISBN, видавничі дані, мова й формат як введено', async () => {
      const user = await registerAccount(app, 'man-full')
      const title = token()
      const number = uniqueIsbn13('quick-add-manual')
      const result = await added(
        user,
        manual(
          {
            title,
            firstPubYear: 1937,
            description: 'Опис',
            authors: [{ name: 'Перший' }, { name: 'Другий' }],
          },
          {
            textKind: 'UNKNOWN',
            lang: 'uk',
            publisher: 'Видавець',
            year: 2020,
            isbn13: number,
            pageCount: 300,
            format: 'HARDCOVER',
          },
        ),
      )

      expect(result.edition).toMatchObject({
        isbn13: number,
        lang: 'uk',
        format: 'HARDCOVER',
        publisher: 'Видавець',
        year: 2020,
        pageCount: 300,
        textKind: 'UNKNOWN',
      })
      expect(result.work).toMatchObject({ firstPubYear: 1937, origLang: null })
      expect(result.authors.map((author) => author.name)).toEqual(['Перший', 'Другий'])
    })

    it('наявний автор за authorId: нове імʼя не створюється, тезка не зливається', async () => {
      const user = await registerAccount(app, 'man-author')
      const author = await prisma.author.create({
        data: { name: `Наявний ${token()}`, nameNorm: 'наявний' },
      })
      const result = await added(
        user,
        manual({ title: token(), authors: [{ authorId: author.id }, { name: author.name }] }),
      )

      expect(result.authors.map((entry) => entry.id)).toContain(author.id)
      expect(await prisma.author.count({ where: { name: author.name } })).toBe(2)
    })
  })

  describe('тип тексту й мова (ред. 2, §1)', () => {
    it('«оригінал» із мовою видання: мова оригіналу НОВОГО твору береться з неї', async () => {
      const user = await registerAccount(app, 'man-original')
      const result = await added(
        user,
        manual({ title: token() }, { textKind: 'ORIGINAL', lang: 'uk' }),
      )

      expect(result.work.origLang).toBe('uk')
      expect(result.edition).toMatchObject({ textKind: 'ORIGINAL', lang: 'uk' })
    })

    it('«оригінал» без мови: мова оригіналу лишається невідомою', async () => {
      const user = await registerAccount(app, 'man-original-null')
      const result = await added(user, manual({ title: token() }, { textKind: 'ORIGINAL' }))

      expect(result.work.origLang).toBeNull()
      expect(result.edition).toMatchObject({ textKind: 'ORIGINAL', lang: null })
    })

    it('мова видання НЕ доводить мови оригіналу, а «не знаю» не робить видання оригіналом', async () => {
      const user = await registerAccount(app, 'man-lang-only')
      const result = await added(
        user,
        manual({ title: token() }, { textKind: 'UNKNOWN', lang: 'de' }),
      )

      expect(result.work.origLang).toBeNull()
      expect(result.edition).toMatchObject({ textKind: 'UNKNOWN', lang: 'de' })
    })

    it('вказана мова оригіналу + «оригінал» без мови видання: мова видання = мова оригіналу; суперечлива — конфлікт', async () => {
      const user = await registerAccount(app, 'man-orig-given')
      const ok = await added(
        user,
        manual({ title: token(), origLang: 'pl' }, { textKind: 'ORIGINAL' }),
      )

      expect(ok.edition.lang).toBe('pl')

      const response = await post(user, {
        operationId: randomUUID(),
        target: manual({ title: token(), origLang: 'pl' }, { textKind: 'ORIGINAL', lang: 'de' }),
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT,
      )
    })
  })

  describe('переклад — необовʼязковий розділ', () => {
    const translation = { translator: 'Олена Оніщук', lang: 'uk', sourceLang: 'en' }

    it('заповнений: створюється Translation, видання — TRANSLATION із мовою перекладу', async () => {
      const user = await registerAccount(app, 'man-translation')
      const result = await added(
        user,
        manual({ title: token(), origLang: 'en' }, { textKind: 'TRANSLATION' }, translation),
      )

      expect(result.edition).toMatchObject({
        textKind: 'TRANSLATION',
        lang: 'uk',
        translator: 'Олена Оніщук',
      })
      expect(await prisma.translation.count({ where: { workId: result.work.id } })).toBe(1)
    })

    it('порожній розділ нічого не створює', async () => {
      const user = await registerAccount(app, 'man-no-translation')
      const result = await added(user, manual({ title: token() }, { textKind: 'UNKNOWN' }))

      expect(await prisma.translation.count({ where: { workId: result.work.id } })).toBe(0)
    })

    it('чинна перевірка полів перекладу: без перекладача чи з неіснуючою мовою — 400', async () => {
      const user = await registerAccount(app, 'man-translation-invalid')

      for (const bad of [
        { lang: 'uk', sourceLang: 'en' },
        { translator: 'Хтось', lang: 'zz', sourceLang: 'en' },
        { translator: '  ', lang: 'uk', sourceLang: 'en' },
      ]) {
        await post(user, {
          operationId: randomUUID(),
          target: manual({ title: token() }, { textKind: 'TRANSLATION' }, bad),
        }).expect(400)
      }
    })

    it('переклад із типом «оригінал» — 422: тип тексту узгоджується з перекладом', async () => {
      const user = await registerAccount(app, 'man-translation-kind')
      const response = await post(user, {
        operationId: randomUUID(),
        target: manual({ title: token() }, { textKind: 'ORIGINAL' }, translation),
      }).expect(422)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EDITION_TEXT_KIND_CONFLICT,
      )
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(0)
    })

    it('мова видання, що суперечить перекладу, — конфлікт, нічого не створено', async () => {
      const user = await registerAccount(app, 'man-translation-lang')
      const title = token()
      const response = await post(user, {
        operationId: randomUUID(),
        target: manual({ title }, { textKind: 'TRANSLATION', lang: 'de' }, translation),
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT,
      )
      expect(await prisma.work.count({ where: { title } })).toBe(0)
    })
  })

  describe('наявний твір («Уточнити видання», сторінка твору)', () => {
    it('додає видання до наявного твору; мова оригіналу твору не змінюється', async () => {
      const user = await registerAccount(app, 'man-existing')
      const first = await added(
        user,
        manual({ title: token(), origLang: 'en' }, { textKind: 'ORIGINAL' }),
      )
      const second = await added(
        user,
        manual({ workId: first.work.id }, { textKind: 'ORIGINAL', publisher: 'Друге' }),
      )

      expect(second.work.id).toBe(first.work.id)
      expect(second.edition.id).not.toBe(first.edition.id)
      expect(second.edition).toMatchObject({ lang: 'en', publisher: 'Друге' })
      expect(await prisma.work.count({ where: { id: first.work.id } })).toBe(1)
    })

    it('невідомий твір — 404; злитий — 409 WORK_MERGED з канонічним id', async () => {
      const user = await registerAccount(app, 'man-merged')
      const canonical = await added(user, manual({ title: token() }))
      const loser = await added(user, manual({ title: token() }))

      await expect(
        post(user, { operationId: randomUUID(), target: manual({ workId: 'no-such-work' }) }),
      ).resolves.toMatchObject({ status: 404 })

      await prisma.work.update({
        where: { id: loser.work.id },
        data: { mergedIntoId: canonical.work.id },
      })

      const response = await post(user, {
        operationId: randomUUID(),
        target: manual({ workId: loser.work.id }),
      }).expect(409)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.WORK_MERGED)
      expect(error.details).toMatchObject({ canonicalWorkId: canonical.work.id })
    })
  })

  describe('ISBN', () => {
    it('ISBN, що вже є в каталозі, — 409 EDITION_ISBN_TAKEN з editionId: інтерфейс веде до наявного видання', async () => {
      const user = await registerAccount(app, 'man-isbn')
      const number = uniqueIsbn13('quick-add-manual')
      const first = await added(
        user,
        manual({ title: token() }, { textKind: 'UNKNOWN', isbn13: number }),
      )
      const title = token()
      const response = await post(user, {
        operationId: randomUUID(),
        target: manual({ title }, { textKind: 'UNKNOWN', isbn13: number }),
      }).expect(409)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.EDITION_ISBN_TAKEN)
      expect(error.details).toEqual({ editionId: first.edition.id })
      expect(await prisma.work.count({ where: { title } })).toBe(0)
    })

    it('невалідний ISBN — 400; відсутній — дозволений', async () => {
      const user = await registerAccount(app, 'man-isbn-invalid')

      await post(user, {
        operationId: randomUUID(),
        target: manual({ title: token() }, { textKind: 'UNKNOWN', isbn13: '1234567890123' }),
      }).expect(400)
      await added(user, manual({ title: token() }, { textKind: 'UNKNOWN' }))
    })
  })

  describe('валідація', () => {
    it.each([
      ['порожня назва', { title: '   ' }],
      ['немає назви', { description: 'x' }],
      ['невідома мова оригіналу', { title: 'Книжка', origLang: 'zz' }],
      ['автор без жодного джерела', { title: 'Книжка', authors: [{}] }],
      [
        'понад 10 авторів',
        {
          title: 'Книжка',
          authors: Array.from({ length: 11 }, (_, i) => ({ name: `А${String(i)}` })),
        },
      ],
      ['зайве поле твору', { title: 'Книжка', ownerId: 'x' }],
    ])('%s — 400', async (_name, work) => {
      const user = await registerAccount(app, 'man-validation')

      await post(user, { operationId: randomUUID(), target: manual(work) }).expect(400)
    })

    it('невідомий тип тексту й зайві поля видання — 400', async () => {
      const user = await registerAccount(app, 'man-validation-edition')

      for (const edition of [
        { textKind: 'OTHER' },
        {},
        { textKind: 'UNKNOWN', translationId: 'x' },
        { textKind: 'UNKNOWN', format: 'GLOSSY' },
        { textKind: 'UNKNOWN', lang: 'zz' },
      ]) {
        await post(user, {
          operationId: randomUUID(),
          target: manual({ title: token() }, edition),
        }).expect(400)
      }
    })
  })

  describe('ідемпотентність й атомарність', () => {
    it('повтор і паралельні дублікати: один Work, одне Edition, один Copy', async () => {
      const user = await registerAccount(app, 'man-idempotent')
      const title = token()
      const body = {
        operationId: randomUUID(),
        target: manual({ title, authors: [{ name: 'Автор' }] }, { textKind: 'UNKNOWN' }),
      }
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(user, body)))

      expect(responses.map((response) => response.status)).toEqual(Array(6).fill(201))
      expect(await prisma.work.count({ where: { title } })).toBe(1)
      expect(await prisma.author.count({ where: { works: { some: { work: { title } } } } })).toBe(1)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(1)
    })

    it('помилка після створення Copy відкочує Work, Author, Translation, Edition й операцію (QA3)', async () => {
      const user = await registerAccount(app, 'man-rollback')
      const title = token()
      const authorName = `Відкат ${token()}`
      const translatorName = `Перекладач ${token()}`
      const number = uniqueIsbn13('quick-add-manual')
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
      const body = {
        operationId: randomUUID(),
        target: manual(
          { title, authors: [{ name: authorName }] },
          { textKind: 'TRANSLATION', isbn13: number },
          { translator: translatorName, lang: 'uk', sourceLang: 'en' },
        ),
      }

      try {
        await post(user, body, failing).expect(500)
      } finally {
        await failing.close()
      }

      expect(await prisma.work.count({ where: { title } })).toBe(0)
      expect(await prisma.author.count({ where: { name: authorName } })).toBe(0)
      expect(await prisma.translation.count({ where: { translator: translatorName } })).toBe(0)
      expect(await prisma.edition.count({ where: { isbn13: number } })).toBe(0)
      expect(
        await prisma.libraryAddOperation.count({ where: { operationId: body.operationId } }),
      ).toBe(0)

      const retried = quickAddResponseSchema.parse((await post(user, body).expect(201)).body)

      expect(retried.replayed).toBe(false)
    })

    it('«ще один примірник» того самого ручного видання — через наявне видання, а не ще один Work', async () => {
      const user = await registerAccount(app, 'man-second')
      const first = await added(user, manual({ title: token() }))
      const second = await added(user, { kind: 'EXISTING_EDITION', editionId: first.edition.id })

      expect(second.edition.id).toBe(first.edition.id)
      expect(await prisma.copy.count({ where: { ownerId: user.id } })).toBe(2)
    })
  })
})
