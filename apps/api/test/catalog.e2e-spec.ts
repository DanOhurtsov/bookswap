import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  API_PREFIX,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  apiErrorSchema,
  catalogSearchResponseSchema,
  editionDetailResponseSchema,
  editionResponseSchema,
  translationListResponseSchema,
  translationResponseSchema,
  workDetailResponseSchema,
  type CatalogSearchResponse,
  type WorkDetailResponse,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { uniqueIsbn13 } from './helpers/unique-isbn'

/**
 * §6.3 і §8, блок «Каталог».
 *
 * ВАЖЛИВО про ізоляцію: e2e-файли ділять одну тестову базу й нічого не чистять
 * між тестами, а пошук за побудовою ходить по всій таблиці. Тому кожен твір тут
 * несе унікальний маркер у назві, і перевірки — це «серед знайденого є ось цей
 * id», а не «знайдено рівно один».
 */
describe('Каталог (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let cookie: string

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)

    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({
        email: uniqueEmail('catalog'),
        password: VALID_PASSWORD,
        displayName: 'Каталогізатор',
      })
      .expect(201)

    cookie = sessionCookie(response.headers)
  })

  /** Registers a SECOND, independent user — cookie and their id. */
  async function registerAnotherUser(): Promise<{ cookie: string; userId: string }> {
    const email = uniqueEmail('catalog-other')
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email, password: VALID_PASSWORD, displayName: 'Інший користувач' })
      .expect(201)

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })

    return { cookie: sessionCookie(response.headers), userId: user.id }
  }

  afterAll(async () => {
    await app.close()
  })

  const url = (path: string): string => `${API_PREFIX}${path}`

  let sequence = 0

  /** Маркер, за яким пошук знайде саме цей запис, а не сусідній тест чи seed. */
  function marker(): string {
    sequence += 1

    return `квітограй${String(process.pid)}${String(sequence)}`
  }

  /**
   * Валідний ISBN-13 для перевіреного namespace цього e2e-файлу
   * (`uniqueIsbn13`, `./helpers/unique-isbn.ts`).
   */
  const isbn = (): string => uniqueIsbn13('catalog')

  async function createWork(body: Record<string, unknown>): Promise<WorkDetailResponse> {
    const response = await request(app.getHttpServer())
      .post(url('/works'))
      .set('Cookie', cookie)
      .send(body)
      .expect(201)

    return workDetailResponseSchema.parse(response.body)
  }

  async function search(
    query: string,
    page?: number,
    pageSize?: number,
  ): Promise<CatalogSearchResponse> {
    const suffix =
      (page === undefined ? '' : `&page=${String(page)}`) +
      (pageSize === undefined ? '' : `&pageSize=${String(pageSize)}`)
    const response = await request(app.getHttpServer())
      .get(url(`/catalog/search?q=${encodeURIComponent(query)}${suffix}`))
      .set('Cookie', cookie)
      .expect(200)

    return catalogSearchResponseSchema.parse(response.body)
  }

  describe('доступ без сесії', () => {
    it.each([
      ['get', '/catalog/search?q=шантарам'],
      ['get', '/works/whatever'],
      ['post', '/works'],
      ['get', '/editions/whatever'],
    ] as const)('%s %s без кукі — 401 з машиночитним code', async (method, path) => {
      const response = await request(app.getHttpServer())[method](url(path)).send({}).expect(401)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.UNAUTHORIZED)
    })
  })

  describe('POST /works', () => {
    it('створює твір із новим автором (§6.3: метадані створює будь-хто)', async () => {
      const token = marker()
      const created = await createWork({
        title: `Шантарам ${token}`,
        origLang: 'en',
        firstPubYear: 2003,
        authors: [{ name: `Ґреґорі Робертс ${token}` }],
      })

      expect(created.work.title).toBe(`Шантарам ${token}`)
      expect(created.authors).toHaveLength(1)
      expect(created.authors[0]?.role).toBe('AUTHOR')
      // Свіжий твір ще не має ні перекладів, ні видань — і це валідна відповідь.
      expect(created.translations).toEqual([])
      expect(created.editions).toEqual([])
    })

    it('переюзає наявного автора за id — але ніколи за збігом імені', async () => {
      const token = marker()
      const first = await createWork({
        title: `Місто ${token}`,
        origLang: 'uk',
        authors: [{ name: `Валерʼян ${token}` }],
      })
      const authorId = first.authors[0]?.id

      const second = await createWork({
        title: `Невеличка драма ${token}`,
        origLang: 'uk',
        authors: [{ authorId, role: 'AUTHOR' }],
      })

      expect(second.authors[0]?.id).toBe(authorId)

      // Те саме імʼя без id дає НОВОГО автора: тезки бувають, і звести їх в одну
      // людину мовчки — гірше, ніж лишити дублікат (§6.3).
      const third = await createWork({
        title: `Третій твір ${token}`,
        origLang: 'uk',
        authors: [{ name: `Валерʼян ${token}` }],
      })

      expect(third.authors[0]?.id).not.toBe(authorId)
    })

    it('приймає кількох авторів із різними ролями', async () => {
      const token = marker()
      const created = await createWork({
        title: `Збірка ${token}`,
        origLang: 'uk',
        authors: [
          { name: `Автор ${token}`, role: 'AUTHOR' },
          { name: `Ілюстратор ${token}`, role: 'ILLUSTRATOR' },
        ],
      })

      expect(created.authors.map((author) => author.role)).toEqual(['AUTHOR', 'ILLUSTRATOR'])
    })

    /**
     * Stage 8e-1, R10a: порядок елементів масиву — єдине джерело `position`.
     * Раніше мапер сортував за роллю (AUTHOR перед ILLUSTRATOR); тепер
     * ILLUSTRATOR, надісланий першим, лишається першим — роль більше не
     * перевизначає ручний порядок.
     */
    it('R10a: порядок авторів у відповіді — це порядок масиву запиту, не роль', async () => {
      const token = marker()
      const created = await createWork({
        title: `Порядок ${token}`,
        origLang: 'uk',
        authors: [
          { name: `Ілюстратор ${token}`, role: 'ILLUSTRATOR' },
          { name: `Автор ${token}`, role: 'AUTHOR' },
        ],
      })

      expect(created.authors.map((author) => author.role)).toEqual(['ILLUSTRATOR', 'AUTHOR'])
      expect(created.authors.map((author) => author.position)).toEqual([0, 1])
    })

    /**
     * Stage 8e-1, R10a: `dedupeAuthorLinks` (`catalog.service.ts`) removes a
     * repeated (authorId, role) pair BEFORE `position` gets assigned — which
     * is exactly why the dropped duplicate leaves no gap in the sequence.
     */
    it('R10a: повторна пара authorId+role у запиті — дедуп без пропусків у position', async () => {
      const token = marker()
      const existing = await createWork({
        title: `Спільний автор ${token}`,
        origLang: 'uk',
        authors: [{ name: `Той самий автор ${token}` }],
      })
      const authorId = existing.authors[0]?.id

      const created = await createWork({
        title: `Дубль пари ${token}`,
        origLang: 'uk',
        authors: [
          { authorId, role: 'AUTHOR' },
          { name: `Другий автор ${token}` },
          { authorId, role: 'AUTHOR' },
        ],
      })

      // The duplicate does not create a second link — two authors, not three.
      expect(created.authors).toHaveLength(2)
      expect(created.authors[0]?.id).toBe(authorId)
      // Positions stay sequential 0, 1 — the dropped duplicate leaves no gap.
      expect(created.authors.map((author) => author.position)).toEqual([0, 1])
    })

    it('неіснуючий автор — 404, твір не створюється', async () => {
      const token = marker()
      const response = await request(app.getHttpServer())
        .post(url('/works'))
        .set('Cookie', cookie)
        .send({
          title: `Привид ${token}`,
          origLang: 'uk',
          authors: [{ authorId: 'author-якого-немає' }],
        })
        .expect(404)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.NOT_FOUND)

      // Транзакція відкотилася цілком: назви серед знайденого немає. Порівняння
      // саме за назвою, а не «пошук нічого не знайшов»: маркери сусідніх тестів
      // мають спільний префікс, і триграми їх одне з одним матчать.
      const titles = (await search(token)).results.map((result) => result.work.title)

      expect(titles).not.toContain(`Привид ${token}`)
    })

    it.each([
      ['невідома мова', { origLang: 'zz' }],
      ['без авторів', { authors: [] }],
      ['порожня назва', { title: '   ' }],
      ['автор і за id, і за іменем', { authors: [{ authorId: 'a-1', name: 'Хтось' }] }],
    ])('%s — 400', async (_name, override) => {
      const response = await request(app.getHttpServer())
        .post(url('/works'))
        .set('Cookie', cookie)
        .send({
          title: `Валідація ${marker()}`,
          origLang: 'uk',
          authors: [{ name: 'Хтось' }],
          ...override,
        })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })
  })

  describe('POST /works/:id/translations і /editions', () => {
    it('веде ланцюг Work → Translation → Edition (§3)', async () => {
      const token = marker()
      const work = await createWork({
        title: `Гобіт ${token}`,
        origLang: 'en',
        authors: [{ name: `Толкін ${token}` }],
      })

      const translationResponse = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/translations`))
        .set('Cookie', cookie)
        .send({
          translator: 'Олена Оніщук',
          lang: 'uk',
          sourceLang: 'en',
          year: 2007,
          hasNotes: true,
        })
        .expect(201)

      const { translation } = translationResponseSchema.parse(translationResponse.body)

      expect(translation.sourceLang).toBe('en')
      expect(translation.hasNotes).toBe(true)
      expect(translation.editionCount).toBe(0)
      // Stage 8e-1, R9: щойно створена сутність починає з revision 1.
      expect(translation.revision).toBe(1)

      const editionResponse = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/editions`))
        .set('Cookie', cookie)
        .send({
          translationId: translation.id,
          publisher: 'Астролябія',
          year: 2021,
          isbn13: isbn(),
          pageCount: 384,
          format: 'PAPERBACK',
        })
        .expect(201)

      const { edition } = editionResponseSchema.parse(editionResponse.body)

      // Мова й перекладач рахуються з перекладу, а не приходять у запиті.
      expect(edition.lang).toBe('uk')
      expect(edition.translator).toBe('Олена Оніщук')
      expect(edition.revision).toBe(1)
      expect(work.work.revision).toBe(1)
    })

    /**
     * Stage 8e-1, R9: `Translation.createdById` is who called
     * `POST /works/:id/translations`, not `Work.createdById` — R8's ownership
     * grants Translation-edit rights by the Translation's own creator (or by
     * owning a Copy of one of its Editions), and that only works if the
     * creator recorded is the actual caller, not whoever happened to create
     * the parent Work.
     */
    it('R9: creator нового Translation — поточний користувач, навіть якщо Work створила інша людина', async () => {
      const token = marker()
      const other = await registerAnotherUser()

      const work = await createWork({
        title: `Чужий твір ${token}`,
        origLang: 'en',
        authors: [{ name: `Автор ${token}` }],
      })

      const translationResponse = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/translations`))
        .set('Cookie', other.cookie)
        .send({ translator: 'Хтось Інший', lang: 'uk', sourceLang: 'en' })
        .expect(201)

      const { translation } = translationResponseSchema.parse(translationResponse.body)

      const [workRow, translationRow] = await Promise.all([
        prisma.work.findUniqueOrThrow({
          where: { id: work.work.id },
          select: { createdById: true },
        }),
        prisma.translation.findUniqueOrThrow({
          where: { id: translation.id },
          select: { createdById: true },
        }),
      ])

      // Work was created through the shared top-level `cookie`; the
      // Translation through `other.cookie` — the creator recorded must be
      // the caller who made THIS request, not the Work's creator.
      expect(translationRow.createdById).toBe(other.userId)
      expect(translationRow.createdById).not.toBe(workRow.createdById)
    })

    it('видання мовою оригіналу: translationId = null → мова з твору', async () => {
      const token = marker()
      const work = await createWork({
        title: `Оригінал ${token}`,
        origLang: 'pl',
        authors: [{ name: `Автор ${token}` }],
      })

      const response = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ translationId: null, publisher: 'Wydawnictwo' })
        .expect(201)

      const { edition } = editionResponseSchema.parse(response.body)

      expect(edition.lang).toBe('pl')
      expect(edition.translator).toBeNull()
    })

    it('переклад чужого твору — 400: Edition посилається і на твір, і на переклад', async () => {
      const token = marker()
      const one = await createWork({
        title: `Перший ${token}`,
        origLang: 'en',
        authors: [{ name: `Автор ${token}` }],
      })
      const other = await createWork({
        title: `Другий ${token}`,
        origLang: 'en',
        authors: [{ name: `Інший ${token}` }],
      })

      const translationResponse = await request(app.getHttpServer())
        .post(url(`/works/${one.work.id}/translations`))
        .set('Cookie', cookie)
        .send({ translator: 'Хтось', lang: 'uk', sourceLang: 'en' })
        .expect(201)

      const { translation } = translationResponseSchema.parse(translationResponse.body)

      const response = await request(app.getHttpServer())
        .post(url(`/works/${other.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ translationId: translation.id })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('зайнятий ISBN — 409 з id наявного видання, щоб клієнт довів до нього людину', async () => {
      const token = marker()
      const work = await createWork({
        title: `ISBN ${token}`,
        origLang: 'uk',
        authors: [{ name: `Автор ${token}` }],
      })
      const number = isbn()

      const first = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ isbn13: number })
        .expect(201)

      const existing = editionResponseSchema.parse(first.body).edition

      const conflict = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ isbn13: number })
        .expect(409)

      const error = apiErrorSchema.parse(conflict.body)

      expect(error.code).toBe(API_ERROR_CODES.EDITION_ISBN_TAKEN)
      expect(error.details).toEqual({ editionId: existing.id })
    })

    it('ISBN із поламаною контрольною сумою — 400 (§11)', async () => {
      const token = marker()
      const work = await createWork({
        title: `Сума ${token}`,
        origLang: 'uk',
        authors: [{ name: `Автор ${token}` }],
      })

      const response = await request(app.getHttpServer())
        .post(url(`/works/${work.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ isbn13: '9783161484101' })
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('переклад чи видання неіснуючого твору — 404', async () => {
      await request(app.getHttpServer())
        .post(url('/works/немає-такого/translations'))
        .set('Cookie', cookie)
        .send({ translator: 'Хтось', lang: 'uk', sourceLang: 'en' })
        .expect(404)

      await request(app.getHttpServer())
        .post(url('/works/немає-такого/editions'))
        .set('Cookie', cookie)
        .send({})
        .expect(404)
    })
  })

  describe('GET /works/:id, /works/:id/translations, /editions/:id', () => {
    it('віддає твір з авторами, перекладами й виданнями — і жодного Copy', async () => {
      const token = marker()
      const created = await createWork({
        title: `Повний ${token}`,
        origLang: 'en',
        authors: [{ name: `Автор ${token}` }],
      })

      const translationResponse = await request(app.getHttpServer())
        .post(url(`/works/${created.work.id}/translations`))
        .set('Cookie', cookie)
        .send({ translator: 'Перекладач', lang: 'uk', sourceLang: 'en', year: 1985 })
        .expect(201)

      const { translation } = translationResponseSchema.parse(translationResponse.body)

      for (const year of [1985, 2021]) {
        await request(app.getHttpServer())
          .post(url(`/works/${created.work.id}/editions`))
          .set('Cookie', cookie)
          .send({ translationId: translation.id, year, publisher: `Видавництво ${String(year)}` })
          .expect(201)
      }

      const response = await request(app.getHttpServer())
        .get(url(`/works/${created.work.id}`))
        .set('Cookie', cookie)
        .expect(200)

      const detail = workDetailResponseSchema.parse(response.body)

      expect(detail.editions.map((edition) => edition.year)).toEqual([2021, 1985])
      expect(detail.translations[0]?.editionCount).toBe(2)
      expect(response.body).not.toHaveProperty('copies')
      expect(JSON.stringify(response.body)).not.toContain('ownerId')
    })

    it('перелік перекладів окремим ендпоінтом (§8)', async () => {
      const token = marker()
      const created = await createWork({
        title: `Переклади ${token}`,
        origLang: 'en',
        authors: [{ name: `Автор ${token}` }],
      })

      for (const year of [2007, 1985]) {
        await request(app.getHttpServer())
          .post(url(`/works/${created.work.id}/translations`))
          .set('Cookie', cookie)
          .send({ translator: `Перекладач ${String(year)}`, lang: 'uk', sourceLang: 'en', year })
          .expect(201)
      }

      const response = await request(app.getHttpServer())
        .get(url(`/works/${created.work.id}/translations`))
        .set('Cookie', cookie)
        .expect(200)

      const { translations } = translationListResponseSchema.parse(response.body)

      // score в усіх нульовий (§10 — етап оцінок), тож порядок задає рік.
      expect(translations.map((translation) => translation.year)).toEqual([1985, 2007])
      expect(translations[0]).not.toHaveProperty('score')
    })

    it('видання окремо — разом із твором, авторами й перекладом', async () => {
      const token = marker()
      const created = await createWork({
        title: `Видання ${token}`,
        origLang: 'en',
        authors: [{ name: `Автор ${token}` }],
      })

      const editionResponse = await request(app.getHttpServer())
        .post(url(`/works/${created.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ publisher: 'Знання' })
        .expect(201)

      const { edition } = editionResponseSchema.parse(editionResponse.body)

      const response = await request(app.getHttpServer())
        .get(url(`/editions/${edition.id}`))
        .set('Cookie', cookie)
        .expect(200)

      const detail = editionDetailResponseSchema.parse(response.body)

      expect(detail.work.id).toBe(created.work.id)
      expect(detail.translation).toBeNull()
      expect(detail.authors).toHaveLength(1)
    })

    it('неіснуючі id — 404', async () => {
      await request(app.getHttpServer()).get(url('/works/немає')).set('Cookie', cookie).expect(404)
      await request(app.getHttpServer())
        .get(url('/works/немає/translations'))
        .set('Cookie', cookie)
        .expect(404)
      await request(app.getHttpServer())
        .get(url('/editions/немає'))
        .set('Cookie', cookie)
        .expect(404)
    })
  })

  describe('GET /catalog/search — fuzzy (§6.3, крок 2)', () => {
    it('знаходить за точною назвою й повертає видання одразу', async () => {
      const token = marker()
      const created = await createWork({
        title: `Шантарам ${token}`,
        origLang: 'en',
        authors: [{ name: `Робертс ${token}` }],
      })

      await request(app.getHttpServer())
        .post(url(`/works/${created.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ publisher: 'КСД', year: 2019 })
        .expect(201)

      const found = (await search(`Шантарам ${token}`)).results.find(
        (result) => result.work.id === created.work.id,
      )

      expect(found?.matchedOn).toBe('TITLE')
      expect(found?.editions[0]?.publisher).toBe('КСД')
      expect(found?.authors).toHaveLength(1)
    })

    it('переживає одрук — заради цього тут триграми, а не LIKE', async () => {
      const token = marker()
      const created = await createWork({
        title: `Шантарам ${token}`,
        origLang: 'en',
        authors: [{ name: `Робертс ${token}` }],
      })

      // Пропущена літера в середині слова.
      const results = await search(`Шантрам ${token}`)

      expect(results.results.map((result) => result.work.id)).toContain(created.work.id)
    })

    it('ігнорує регістр і діакритику — саме це робить unaccent у titleNorm', async () => {
      const token = marker()
      const created = await createWork({
        title: `Café Zürich ${token}`,
        origLang: 'de',
        authors: [{ name: `Autor ${token}` }],
      })

      const results = await search(`CAFE ZURICH ${token}`)

      expect(results.results.map((result) => result.work.id)).toContain(created.work.id)
    })

    it('знаходить за початком назви — короткий запит триграми не витягують', async () => {
      const token = marker()
      const created = await createWork({
        title: `Незвіданий ${token}`,
        origLang: 'uk',
        authors: [{ name: `Автор ${token}` }],
      })

      const results = await search(token)

      expect(results.results.map((result) => result.work.id)).toContain(created.work.id)
    })

    it('знаходить за автором і каже про це в matchedOn (§8)', async () => {
      const token = marker()
      const created = await createWork({
        title: `Безіменна книжка ${token}`,
        origLang: 'uk',
        authors: [{ name: `Соломія Кримська ${token}` }],
      })

      const results = await search(`Соломія Кримська ${token}`)
      const found = results.results.find((result) => result.work.id === created.work.id)

      expect(found?.matchedOn).toBe('AUTHOR')
      // Ті самі автори окремим списком — для кроку майстра «виберіть автора».
      expect(results.authorMatches.map((author) => author.id)).toContain(created.authors[0]?.id)
      expect(
        results.authorMatches.find((author) => author.id === created.authors[0]?.id)?.workCount,
      ).toBe(1)
    })

    /**
     * Регресія: короткий фрагмент імені знаходив автора, але не його твори.
     *
     * `similarity('ґреґорі девід робертс…', 'ґре')` ≈ 0.13 — нижче порога 0.3,
     * тож оператор `%` не спрацьовує, а `LIKE` спершу стояв лише на назві твору.
     * Наслідок: у видачі був автор без жодної своєї книжки — це виглядає як
     * поламаний пошук саме на третій набраній літері.
     */
    it('короткий фрагмент імені автора знаходить і його твір, і його самого', async () => {
      const token = marker()
      // Назва навмисно НЕ містить фрагмента: збіг має прийти виключно з імені.
      const created = await createWork({
        title: `Шантарам ${token}`,
        origLang: 'en',
        authors: [{ name: `Ґреґорі Девід Робертс ${token}` }],
      })
      const authorId = created.authors[0]?.id

      const results = await search('ґре')
      const found = results.results.find((result) => result.work.id === created.work.id)

      expect(found).toBeDefined()
      expect(found?.matchedOn).toBe('AUTHOR')
      expect(found?.authors.map((author) => author.id)).toContain(authorId)
      // Автор лишається і в окремому списку — обидві гілки мусять бути узгоджені.
      expect(results.authorMatches.map((author) => author.id)).toContain(authorId)
    })

    it('шукає за ISBN точним збігом: схожий номер — це інша книжка', async () => {
      const token = marker()
      const created = await createWork({
        title: `За номером ${token}`,
        origLang: 'uk',
        authors: [{ name: `Автор ${token}` }],
      })
      const number = isbn()

      await request(app.getHttpServer())
        .post(url(`/works/${created.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ isbn13: number })
        .expect(201)

      const byPlain = await search(number)
      const byHyphens = await search(`${number.slice(0, 3)}-${number.slice(3)}`)

      expect(byPlain.results).toHaveLength(1)
      expect(byPlain.results[0]?.work.id).toBe(created.work.id)
      expect(byPlain.results[0]?.matchedOn).toBe('ISBN')
      expect(byHyphens.results[0]?.work.id).toBe(created.work.id)
    })

    it('нічого не знайдено — порожні списки, а не помилка', async () => {
      const results = await search(`ніякогослова${String(process.pid)}зовсім`)

      expect(results.results).toEqual([])
      expect(results.authorMatches).toEqual([])
    })

    it('символи LIKE у запиті не перетворюють його на шаблон «усе підряд»', async () => {
      // Без екранування «%_» стало б шаблоном, який матчить будь-що, і пошук
      // повернув би двадцять випадкових творів замість нічого.
      const results = await search('%_')

      expect(results.results).toEqual([])
    })

    it('запит коротший за два символи — 400', async () => {
      const response = await request(app.getHttpServer())
        .get(url('/catalog/search?q=ш'))
        .set('Cookie', cookie)
        .expect(400)

      expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
    })

    it('віддає не більше однієї сторінки творів (§11)', async () => {
      const token = marker()

      for (let index = 0; index < 22; index += 1) {
        await createWork({
          title: `Серія ${token} том ${String(index)}`,
          origLang: 'uk',
          authors: [{ name: `Плідний автор ${token}` }],
        })
      }

      const results = await search(`Серія ${token} том`)

      expect(results.results).toHaveLength(DEFAULT_SEARCH_PAGE_SIZE)
      expect(results).toMatchObject({ page: 1, hasMore: true })
    })
  })

  describe('GET /catalog/search — сторінки', () => {
    /**
     * `n` творів з одним маркером у назві — щоб запит знаходив саме їх, а не
     * сусідній тест чи сид. ISBN дають кожному видання, бо на них тримається
     * `knownIsbn13`.
     */
    async function series(count: number): Promise<{ token: string; ids: string[] }> {
      const token = marker()
      const ids: string[] = []

      for (let index = 0; index < count; index += 1) {
        const created = await createWork({
          title: `Томик ${token} ${String(index).padStart(2, '0')}`,
          origLang: 'uk',
          authors: [{ name: `Автор ${token}` }],
        })

        await request(app.getHttpServer())
          .post(url(`/works/${created.work.id}/editions`))
          .set('Cookie', cookie)
          .send({ publisher: 'КСД', year: 2019, isbn13: isbn() })
          .expect(201)

        ids.push(created.work.id)
      }

      return { token, ids }
    }

    /**
     * Сторінки 1…N одного запиту.
     *
     * Гортаємо, поки сервер каже «є ще», з жорсткою межею: тести цього файлу
     * ділять одну базу, і в збіги за маркером законно потрапляють сусідні
     * тести. Саме тому перевірки нижче — про ІНВАРІАНТИ (нічого не задвоїлося,
     * нічого не загубилося), а не про точний склад сторінки: чужі збіги його
     * змінюють, а інваріанти — ні.
     */
    async function walk(
      query: string,
      pageSize?: number,
      limit = SEARCH_MAX_PAGE,
    ): Promise<CatalogSearchResponse[]> {
      const pages: CatalogSearchResponse[] = []

      for (let page = 1; page <= limit; page += 1) {
        const response = await search(query, page, pageSize)
        pages.push(response)

        if (!response.hasMore) break
      }

      return pages
    }

    it('сторінки нарізають ранжування, не повторюючи й не гублячи творів', async () => {
      const { token, ids } = await series(22)
      const pages = await walk(`Томик ${token}`)

      expect(pages.length).toBeGreaterThan(1)

      const seen = pages.flatMap((page) => page.results.map((result) => result.work.id))

      // Жоден твір не показався двічі…
      expect(new Set(seen).size).toBe(seen.length)
      // …і жоден із наших не зник між сторінками.
      for (const id of ids) expect(seen).toContain(id)

      // Повна сторінка скрізь, окрім останньої: інакше рядки губилися б на межі.
      for (const page of pages.slice(0, -1)) {
        expect(page.results).toHaveLength(DEFAULT_SEARCH_PAGE_SIZE)
        expect(page.hasMore).toBe(true)
      }

      expect(pages.at(-1)?.hasMore).toBe(false)
    })

    it('порядок відтворюваний: та сама сторінка двічі — той самий склад', async () => {
      const { token } = await series(14)
      const query = `Томик ${token}`

      const [once, twice] = await Promise.all([search(query, 2), search(query, 2)])

      // Тотальний порядок (`score, titleNorm, id`) — без нього рядок міг би
      // перестрибнути між сторінками, зникнувши з однієї й задвоївшись на іншій.
      expect(once.results.map((result) => result.work.id)).toEqual(
        twice.results.map((result) => result.work.id),
      )
    })

    it('total — точна кількість ВСІХ збігів, однакова на кожній сторінці', async () => {
      const { token, ids } = await series(14)
      const query = `Томик ${token}`

      const first = await search(query, 1)
      const second = await search(query, 2)

      // Саме з `total` зовнішній ендпоінт рахує, скільки рядків сторінки наші:
      // пряме посилання на сторінку 2 не бачило сторінки 1.
      expect(first.results).toHaveLength(DEFAULT_SEARCH_PAGE_SIZE)
      expect(first.total).toBeGreaterThanOrEqual(ids.length)
      expect(second.total).toBe(first.total)
      expect(first.pageSize).toBe(DEFAULT_SEARCH_PAGE_SIZE)
    })

    it.each([10, 20, 50])(
      'pageSize=%s — стільки карток на сторінці, без повторів між сторінками',
      async (size) => {
        const { token, ids } = await series(24)
        const pages = await walk(`Томик ${token}`, size)
        const seen = pages.flatMap((page) => page.results.map((result) => result.work.id))

        expect(new Set(seen).size).toBe(seen.length)
        for (const id of ids) expect(seen).toContain(id)

        for (const page of pages.slice(0, -1)) {
          expect(page.results).toHaveLength(size)
          expect(page.pageSize).toBe(size)
        }
      },
    )

    it('локальна частина повністю в межах сторінки: hasMore — за total, а не за здогадом', async () => {
      const { token } = await series(12)
      const first = await search(`Томик ${token}`, 1, 10)
      const all = await search(`Томик ${token}`, 1, 50)

      expect(first.hasMore).toBe(first.total > 10)
      expect(all.hasMore).toBe(all.total > 50)
    })

    it('недопустимий pageSize — 400, а не найближчий допустимий', async () => {
      for (const pageSize of ['0', '5', '15', '100', 'abc']) {
        const response = await request(app.getHttpServer())
          .get(url(`/catalog/search?q=шантарам&pageSize=${pageSize}`))
          .set('Cookie', cookie)
          .expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }
    })

    it('сторінка за межами збігів порожня, а не повторює останню', async () => {
      const response = await search(`ніякогослова${String(process.pid)}зовсім`, 4)

      expect(response.results).toEqual([])
      expect(response).toMatchObject({ page: 4, hasMore: false })
    })

    it('поламаний номер сторінки — 400, а не мовчазна перша сторінка', async () => {
      for (const page of ['0', '-2', 'abc', '999']) {
        const response = await request(app.getHttpServer())
          .get(url(`/catalog/search?q=шантарам&page=${page}`))
          .set('Cookie', cookie)
          .expect(400)

        expect(apiErrorSchema.parse(response.body).code).toBe(API_ERROR_CODES.VALIDATION_ERROR)
      }
    })

    it('точний збіг за ISBN не має другої сторінки', async () => {
      const token = marker()
      const created = await createWork({
        title: `Єдиний ${token}`,
        origLang: 'uk',
        authors: [{ name: `Автор ${token}` }],
      })
      const number = isbn()

      await request(app.getHttpServer())
        .post(url(`/works/${created.work.id}/editions`))
        .set('Cookie', cookie)
        .send({ publisher: 'КСД', year: 2019, isbn13: number })
        .expect(201)

      const first = await search(number, 1)
      const second = await search(number, 2)

      expect(first.results).toHaveLength(1)
      expect(first.hasMore).toBe(false)
      expect(second.results).toEqual([])
    })
  })
})
