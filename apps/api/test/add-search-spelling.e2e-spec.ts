import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  addSearchExternalResponseSchema,
  addSearchResponseSchema,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { ExternalSearchCache } from '../src/catalog/search/external/external-search.cache'
import { EXTERNAL_SEARCH_PROVIDERS } from '../src/catalog/search/external/external-search-provider'
import { ProviderRateLimiter } from '../src/catalog/search/external/provider-rate-limiter'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { registerAccount, url } from './loan.helpers'
import { FakeExternalSearchProvider } from './lookup/fake-external-search-provider'

/**
 * Підказка виправлення написання (`spellingSuggestion` у `/me/library/add-search[/suggest][/external]`).
 * Локальна половина рішає за нашим каталогом; зовнішня — за каталогом і записами джерел разом.
 * Джерела — фейки (§11): жодного реального HTTP. Назви — унікальні випадкові слова: інші e2e-файли ділять
 * з нами одну базу, і чужі твори не повинні ні давати підказку, ні ховати її.
 */
describe('підказка виправлення написання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
  const googleBooks = new FakeExternalSearchProvider('GOOGLE_BOOKS')
  const ORIGINAL_INTERVAL = process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
  const ORIGINAL_GAP = process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS

  beforeAll(async () => {
    process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = '1'
    process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = '1'
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(EXTERNAL_SEARCH_PROVIDERS).useValue([openLibrary, googleBooks])
      },
    })
    prisma = app.get(PrismaService)
  })

  afterEach(() => {
    openLibrary.clear()
    googleBooks.clear()
    app.get(ExternalSearchCache).clear()
    app.get(ProviderRateLimiter).clear()
  })

  afterAll(async () => {
    if (ORIGINAL_INTERVAL === undefined) delete process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS
    else process.env.CATALOG_EXTERNAL_SEARCH_MIN_INTERVAL_MS = ORIGINAL_INTERVAL

    if (ORIGINAL_GAP === undefined) delete process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS
    else process.env.CATALOG_EXTERNAL_SUGGEST_MIN_GAP_MS = ORIGINAL_GAP

    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  /** Унікальне слово з 17 символів: одна замінена літера лишає ~0.7 триграмної схожості. */
  const token = (): string => `Zqx${randomUUID().replaceAll('-', '').slice(0, 14)}`

  /** Те саме слово з однією іншою літерою всередині (hex-слово не містить `y` і `w`). */
  const withTypo = (word: string, replacement = 'y'): string =>
    `${word.slice(0, 8)}${replacement}${word.slice(9)}`

  async function createWork(
    owner: Account,
    title: string,
    authorName = 'Автор Тест',
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', owner.cookie)
      .send({ title, origLang: 'en', authors: [{ name: authorName }] })
      .expect(201)

    return (response.body as { work: { id: string } }).work.id
  }

  async function ask(account: Account, path: 'add-search' | 'add-search/suggest', query: string) {
    const response = await request(app.getHttpServer())
      .get(url(`/me/library/${path}?q=${encodeURIComponent(query)}`))
      .set('Cookie', account.cookie)
      .expect(200)

    return addSearchResponseSchema.parse(response.body)
  }

  describe.each(['add-search', 'add-search/suggest'] as const)('GET /me/library/%s', (path) => {
    it('помилка в написанні назви → наявна назва, прив’язана до цього запиту', async () => {
      const account = await registerAccount(app, 'sp-title')
      const word = token()

      await createWork(account, word)

      const typo = withTypo(word)
      const result = await ask(account, path, `  ${typo}  `)

      expect(result.spellingSuggestion).toEqual({ forQuery: typo, text: word })
    })

    it('помилка в імені автора → наявне імʼя автора', async () => {
      const account = await registerAccount(app, 'sp-author')
      const author = `Іван ${token()}`

      await createWork(account, token(), author)

      const result = await ask(account, path, withTypo(author))

      expect(result.spellingSuggestion?.text).toBe(author)
    })

    it('правильний запит і початок назви (частковий збіг) підказки не мають', async () => {
      const account = await registerAccount(app, 'sp-correct')
      const word = token()

      await createWork(account, word)

      expect((await ask(account, path, word)).spellingSuggestion).toBeUndefined()
      expect((await ask(account, path, word.slice(0, 10))).spellingSuggestion).toBeUndefined()
      expect((await ask(account, path, word.toLowerCase())).spellingSuggestion).toBeUndefined()
    })

    it('неоднозначний запит: однаково схожі на дві різні назви — підказки немає', async () => {
      const account = await registerAccount(app, 'sp-ambiguous')
      const word = token()

      await createWork(account, withTypo(word, 'y'))
      await createWork(account, withTypo(word, 'w'))

      const result = await ask(account, path, word)

      // Результати є (обидва твори схожі), а підказки немає: вибрати між ними було б жеребкуванням.
      expect(result.total).toBeGreaterThanOrEqual(2)
      expect(result.spellingSuggestion).toBeUndefined()
    })

    it('дві записи з однаковою назвою — не неоднозначність', async () => {
      const account = await registerAccount(app, 'sp-duplicates')
      const word = token()

      await createWork(account, word)
      await createWork(account, word)

      expect((await ask(account, path, withTypo(word))).spellingSuggestion?.text).toBe(word)
    })

    it('короткий запит (менше 4 символів) підказки не має', async () => {
      const account = await registerAccount(app, 'sp-short')

      await createWork(account, 'Кіт')

      expect((await ask(account, path, 'Кіи')).spellingSuggestion).toBeUndefined()
    })

    it('ISBN підказки не має', async () => {
      const account = await registerAccount(app, 'sp-isbn')
      const isbn = uniqueIsbn13('spelling-isbn')

      expect((await ask(account, path, isbn)).spellingSuggestion).toBeUndefined()
    })

    it('злитий твір не пропонується', async () => {
      const account = await registerAccount(app, 'sp-merged')
      const word = token()
      const merged = await createWork(account, word)
      const canonical = await createWork(account, token())

      await prisma.work.update({ where: { id: merged }, data: { mergedIntoId: canonical } })

      expect((await ask(account, path, withTypo(word))).spellingSuggestion).toBeUndefined()
    })
  })

  describe.each(['add-search/external', 'add-search/suggest/external'] as const)(
    'GET /me/library/%s',
    (path) => {
      const edition = (
        id: string,
        title: string,
        source: 'GOOGLE_BOOKS' | 'OPEN_LIBRARY' = 'GOOGLE_BOOKS',
        authors = ['Автор Джерела'],
      ): ExternalSearchResult => ({
        id: `${source}:${id}`,
        kind: 'EDITION',
        sources: [source],
        title,
        authors,
        isbn13: uniqueIsbn13(`spelling-${id}`),
      })

      async function askExternal(account: Account, query: string) {
        const response = await request(app.getHttpServer())
          .get(url(`/me/library/${path}?q=${encodeURIComponent(query)}`))
          .set('Cookie', account.cookie)
          .expect(200)

        return addSearchExternalResponseSchema.parse(response.body)
      }

      it('наша БД не має книжки, джерело повернуло правильну назву → підказка з джерела', async () => {
        const account = await registerAccount(app, 'sp-ext-empty')
        const word = token()

        googleBooks.returns([edition('a', word)])

        const typo = withTypo(word)
        const result = await askExternal(account, typo)

        expect(result.spellingSuggestion).toEqual({ forQuery: typo, text: word })
      })

      it('кандидат, відкинутий воротами релевантності, доступний для підказки, але карткою не стає', async () => {
        const account = await registerAccount(app, 'sp-ext-gate')
        const word = token()

        googleBooks.returns([], [edition('a', word)])

        const result = await askExternal(account, withTypo(word))

        expect(result.items).toEqual([])
        expect(result.spellingSuggestion?.text).toBe(word)
      })

      it('кілька видань однієї назви (два джерела, різні автори) — не неоднозначність', async () => {
        const account = await registerAccount(app, 'sp-ext-editions')
        const word = token()

        googleBooks.returns([
          edition('a', word),
          edition('b', word, 'GOOGLE_BOOKS', ['Інший Автор']),
          edition('c', word.toUpperCase()),
        ])
        openLibrary.returns([edition('d', word, 'OPEN_LIBRARY')])

        expect((await askExternal(account, withTypo(word))).spellingSuggestion?.text).toBe(word)
      })

      it('збіг нашої книжки і запису джерела за назвою — одна підказка', async () => {
        const account = await registerAccount(app, 'sp-ext-agree')
        const word = token()

        await createWork(account, word)
        googleBooks.returns([edition('a', word)])

        expect((await askExternal(account, withTypo(word))).spellingSuggestion?.text).toBe(word)
      })

      it('правильний запит: підказки немає', async () => {
        const account = await registerAccount(app, 'sp-ext-correct')
        const word = token()

        googleBooks.returns([edition('a', word)])

        expect((await askExternal(account, word)).spellingSuggestion).toBeUndefined()
        // Початок назви — теж звичайний збіг.
        expect((await askExternal(account, word.slice(0, 10))).spellingSuggestion).toBeUndefined()
      })

      it('джерела суперечать одне одному — без підказки', async () => {
        const account = await registerAccount(app, 'sp-ext-conflict')
        const word = token()

        googleBooks.returns([], [edition('a', withTypo(word, 'y'))])
        openLibrary.returns([], [edition('b', withTypo(word, 'w'), 'OPEN_LIBRARY')])

        expect((await askExternal(account, word)).spellingSuggestion).toBeUndefined()
      })

      it('наш каталог і джерело суперечать — останнє слово за спільним рішенням: без підказки', async () => {
        const account = await registerAccount(app, 'sp-ext-split')
        const word = token()

        await createWork(account, withTypo(word, 'y'))
        googleBooks.returns([], [edition('a', withTypo(word, 'w'))])

        // Сама локальна половина бачить лише свого кандидата й підказала б його…
        expect((await ask(account, 'add-search', word)).spellingSuggestion?.text).toBe(
          withTypo(word, 'y'),
        )
        // …а зовнішня знає обох і мовчить.
        expect((await askExternal(account, word)).spellingSuggestion).toBeUndefined()
      })

      it('ISBN: підказки немає, хоч би що відповіли джерела', async () => {
        const account = await registerAccount(app, 'sp-ext-isbn')

        googleBooks.returns([edition('a', token())])

        const result = await askExternal(account, uniqueIsbn13('spelling-ext-isbn'))

        expect(result.spellingSuggestion).toBeUndefined()

        // Автопідказки за ISBN не питають джерел узагалі (повний пошук — наявна поведінка, не змінена).
        if (path === 'add-search/suggest/external') {
          expect(googleBooks.blocks).toHaveLength(0)
          expect(openLibrary.blocks).toHaveLength(0)
        }
      })

      it('підказка не додає звернень до джерел; повтор іде з кешу, підказка та сама', async () => {
        const account = await registerAccount(app, 'sp-ext-cost')
        const word = token()
        const typo = withTypo(word)

        googleBooks.returns([], [edition('a', word)])
        openLibrary.returns([], [edition('b', word, 'OPEN_LIBRARY')])

        const first = await askExternal(account, typo)
        const asked = [openLibrary.blocks.length, googleBooks.blocks.length]
        const second = await askExternal(account, typo)

        expect(first.spellingSuggestion?.text).toBe(word)
        // Один блок на джерело — рівно стільки, скільки й без підказки.
        expect(asked).toEqual([1, 1])
        if (path === 'add-search/suggest/external') {
          expect(googleBooks.blocks[0]).toMatchObject({ maxQueries: 1 })
        }
        // Другий раз джерела не чіпаємо, а кандидати приїхали разом із кешованим блоком.
        expect([openLibrary.blocks.length, googleBooks.blocks.length]).toEqual(asked)
        expect(second.spellingSuggestion).toEqual(first.spellingSuggestion)
      })
    },
  )
})
