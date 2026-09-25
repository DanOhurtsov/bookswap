import {
  CATALOG_LIMITS,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  SEARCH_PAGE_SIZES,
  catalogSearchRequestSchema,
  catalogSearchResponseSchema,
  searchCandidatesRequestSchema,
  createEditionRequestSchema,
  createTranslationRequestSchema,
  createWorkRequestSchema,
  editionSchema,
  searchCandidatesResponseSchema,
  splitSearchPage,
  translationSchema,
} from './catalog'

const work = {
  title: 'Шантарам',
  origLang: 'en',
  authors: [{ name: 'Ґреґорі Девід Робертс' }],
}

describe('createWorkRequestSchema', () => {
  it('приймає мінімальний твір з одним новим автором', () => {
    expect(createWorkRequestSchema.parse(work).authors).toHaveLength(1)
  })

  it('приймає посилання на наявного автора', () => {
    const parsed = createWorkRequestSchema.parse({
      ...work,
      authors: [{ authorId: 'author-1', role: 'AUTHOR' }],
    })

    expect(parsed.authors[0]?.authorId).toBe('author-1')
  })

  it('вимагає РІВНО одне з authorId / name — тезки не зводяться автоматично', () => {
    expect(
      createWorkRequestSchema.safeParse({ ...work, authors: [{ authorId: 'a-1', name: 'Хтось' }] })
        .success,
    ).toBe(false)
    expect(
      createWorkRequestSchema.safeParse({ ...work, authors: [{ role: 'EDITOR' }] }).success,
    ).toBe(false)
  })

  it('вимагає хоча б одного автора', () => {
    expect(createWorkRequestSchema.safeParse({ ...work, authors: [] }).success).toBe(false)
  })

  it('повертає придатне для форми повідомлення про порожнє імʼя автора', () => {
    const result = createWorkRequestSchema.safeParse({ ...work, authors: [{ name: '' }] })

    expect(result.error?.issues[0]?.message).toBe('Не вказано імʼя автора')
  })

  it('відхиляє більше за стелю авторів', () => {
    const authors = Array.from({ length: CATALOG_LIMITS.authorsMax + 1 }, (_, index) => ({
      name: `Автор ${String(index)}`,
    }))

    expect(createWorkRequestSchema.safeParse({ ...work, authors }).success).toBe(false)
  })

  it('валідує origLang як ISO 639-1', () => {
    expect(createWorkRequestSchema.safeParse({ ...work, origLang: 'zz' }).success).toBe(false)
    expect(createWorkRequestSchema.parse({ ...work, origLang: ' EN ' }).origLang).toBe('en')
  })

  it('обрізає назву й відхиляє порожню', () => {
    expect(createWorkRequestSchema.parse({ ...work, title: '  Шантарам  ' }).title).toBe('Шантарам')
    expect(createWorkRequestSchema.safeParse({ ...work, title: '   ' }).success).toBe(false)
  })

  it('тримає рік у розумних межах, але пускає до нашої ери', () => {
    expect(createWorkRequestSchema.safeParse({ ...work, firstPubYear: -750 }).success).toBe(true)
    expect(createWorkRequestSchema.safeParse({ ...work, firstPubYear: 2_500 }).success).toBe(false)
    expect(createWorkRequestSchema.safeParse({ ...work, firstPubYear: 2003.5 }).success).toBe(false)
  })
})

describe('createTranslationRequestSchema', () => {
  const translation = { translator: 'Олександр Мокровольський', lang: 'uk', sourceLang: 'en' }

  it('приймає переклад із мовою-джерелом (§10.3)', () => {
    expect(createTranslationRequestSchema.parse(translation)).toMatchObject(translation)
  })

  it('вимагає перекладача', () => {
    expect(
      createTranslationRequestSchema.safeParse({ ...translation, translator: '  ' }).success,
    ).toBe(false)
  })

  it('валідує обидві мови', () => {
    expect(createTranslationRequestSchema.safeParse({ ...translation, lang: 'zz' }).success).toBe(
      false,
    )
    expect(
      createTranslationRequestSchema.safeParse({ ...translation, sourceLang: 'zz' }).success,
    ).toBe(false)
  })
})

describe('createEditionRequestSchema', () => {
  it('приймає порожнє тіло — видання мовою оригіналу без відомих деталей', () => {
    expect(createEditionRequestSchema.safeParse({}).success).toBe(true)
  })

  it('нормалізує ISBN і перевіряє контрольну суму', () => {
    expect(createEditionRequestSchema.parse({ isbn13: '978-3-16-148410-0' }).isbn13).toBe(
      '9783161484100',
    )
    expect(createEditionRequestSchema.safeParse({ isbn13: '978-3-16-148410-1' }).success).toBe(
      false,
    )
  })

  it('дозволяє явний null для ISBN — «номера немає» це не «поле забули»', () => {
    expect(createEditionRequestSchema.parse({ isbn13: null }).isbn13).toBeNull()
  })

  it('відхиляє непозитивну кількість сторінок і не-URL обкладинку', () => {
    expect(createEditionRequestSchema.safeParse({ pageCount: 0 }).success).toBe(false)
    expect(createEditionRequestSchema.safeParse({ coverUrl: 'не посилання' }).success).toBe(false)
  })
})

describe('catalogSearchRequestSchema', () => {
  it('вимагає щонайменше два символи', () => {
    expect(catalogSearchRequestSchema.safeParse({ q: 'ш' }).success).toBe(false)
    expect(catalogSearchRequestSchema.parse({ q: '  шан  ' }).q).toBe('шан')
  })

  it('адреса без page — це перша сторінка, а не помилка', () => {
    expect(catalogSearchRequestSchema.parse({ q: 'шан' }).page).toBe(1)
  })

  it('читає номер сторінки з рядка адреси', () => {
    expect(catalogSearchRequestSchema.parse({ q: 'шан', page: '3' }).page).toBe(3)
  })

  it('поламаний номер сторінки відхиляється, а не округлюється до першої', () => {
    // Мовчки віддати іншу сторінку, ніж називає адреса, означало б, що «назад»
    // веде людину туди, де вона не була.
    for (const page of ['0', '-1', 'abc', '2.5', String(SEARCH_MAX_PAGE + 1)]) {
      expect(catalogSearchRequestSchema.safeParse({ q: 'шан', page }).success).toBe(false)
    }
  })
})

describe('pageSize', () => {
  it('без pageSize — типові 10', () => {
    expect(catalogSearchRequestSchema.parse({ q: 'шан' }).pageSize).toBe(DEFAULT_SEARCH_PAGE_SIZE)
  })

  it.each(SEARCH_PAGE_SIZES)('приймає %s з рядка адреси', (size) => {
    expect(catalogSearchRequestSchema.parse({ q: 'шан', pageSize: String(size) }).pageSize).toBe(
      size,
    )
  })

  it('недопустимий розмір — помилка, а не найближче допустиме', () => {
    for (const pageSize of ['0', '5', '15', '100', 'abc', '10.5']) {
      expect(catalogSearchRequestSchema.safeParse({ q: 'шан', pageSize }).success).toBe(false)
    }
  })
})

describe('splitSearchPage', () => {
  const split = (page: number, pageSize: number, localTotal: number) =>
    splitSearchPage({ page, pageSize, localTotal })

  it('без локальних збігів усе зовнішнє, зі зсувом за номером сторінки', () => {
    expect(split(1, 10, 0)).toEqual({
      localFrom: 0,
      localCount: 0,
      externalFrom: 0,
      externalCount: 10,
    })
    expect(split(3, 10, 0)).toMatchObject({ externalFrom: 20, externalCount: 10 })
  })

  it('перша сторінка ділиться: локальні першими, решта зовнішні', () => {
    expect(split(1, 10, 3)).toEqual({
      localFrom: 0,
      localCount: 3,
      externalFrom: 0,
      externalCount: 7,
    })
  })

  it('межа: локальні закінчуються рівно на кінці сторінки', () => {
    expect(split(1, 10, 10)).toMatchObject({ localCount: 10, externalCount: 0 })
    expect(split(2, 10, 10)).toMatchObject({ localCount: 0, externalFrom: 0, externalCount: 10 })
  })

  it('сторінка, що перетинає межу, бере хвіст локальних і початок зовнішніх', () => {
    expect(split(2, 10, 14)).toEqual({
      localFrom: 10,
      localCount: 4,
      externalFrom: 0,
      externalCount: 6,
    })
    expect(split(3, 10, 14)).toMatchObject({ localCount: 0, externalFrom: 6, externalCount: 10 })
  })

  it('кожна сторінка — рівно pageSize рядків, без повторів і дірок між сторінками', () => {
    for (const pageSize of SEARCH_PAGE_SIZES) {
      for (const localTotal of [0, 1, 9, 10, 11, 49, 50, 51, 200]) {
        let expectedLocal = 0
        let expectedExternal = 0

        for (let page = 1; page <= SEARCH_MAX_PAGE; page += 1) {
          const part = split(page, pageSize, localTotal)

          expect(part.localCount + part.externalCount).toBe(pageSize)
          expect(part.localFrom).toBe(expectedLocal)
          expect(part.externalFrom).toBe(expectedExternal)

          expectedLocal += part.localCount
          expectedExternal += part.externalCount
        }
      }
    }
  })
})

describe('searchCandidatesRequestSchema', () => {
  it('без page і pageSize — перший екран: саме так кличе його перевірка дублікатів', () => {
    expect(searchCandidatesRequestSchema.parse({ q: 'шан' })).toEqual({
      q: 'шан',
      page: 1,
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
    })
  })
})

describe('catalogSearchResponseSchema', () => {
  const page = { results: [], authorMatches: [], page: 1, pageSize: 10, total: 0, hasMore: false }

  it('несе сторінку, розмір, точну кількість і ознаку «є ще»', () => {
    const parsed = catalogSearchResponseSchema.parse({
      ...page,
      page: 2,
      pageSize: 20,
      total: 45,
      hasMore: true,
    })

    expect(parsed).toMatchObject({ page: 2, pageSize: 20, total: 45, hasMore: true })
  })

  it('не приймає більше за найбільший розмір сторінки', () => {
    const results = Array.from({ length: Math.max(...SEARCH_PAGE_SIZES) + 1 }, () => ({
      work: {
        id: 'w',
        title: 'Шантарам',
        origLang: 'en',
        firstPubYear: null,
        description: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        revision: 1,
      },
      authors: [],
      editions: [],
      matchedOn: 'TITLE',
    }))

    expect(catalogSearchResponseSchema.safeParse({ ...page, results }).success).toBe(false)
  })

  it('без total сторінка не відповідає: керування без нього не порахувати', () => {
    expect(
      catalogSearchResponseSchema.safeParse({ results: [], authorMatches: [], page: 1 }).success,
    ).toBe(false)
  })
})

describe('проєкції', () => {
  it('translationSchema не віддає ранг — правило cold start §10.3 приїде з етапом оцінок', () => {
    const parsed = translationSchema.parse({
      id: 't-1',
      workId: 'w-1',
      translator: 'Хтось',
      lang: 'uk',
      sourceLang: 'en',
      year: null,
      isAbridged: false,
      hasNotes: true,
      notes: null,
      editionCount: 2,
      revision: 1,
      score: 4.9,
      ratingAvg: 4.9,
    })

    expect(parsed).not.toHaveProperty('score')
    expect(parsed).not.toHaveProperty('ratingAvg')
  })

  it('editionSchema несе обчислені lang і translator', () => {
    const parsed = editionSchema.parse({
      id: 'e-1',
      workId: 'w-1',
      translationId: null,
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: 'PAPERBACK',
      lang: 'en',
      translator: null,
      revision: 1,
    })

    expect(parsed.lang).toBe('en')
    expect(parsed.translator).toBeNull()
  })
})

describe('searchCandidatesResponseSchema', () => {
  const workDetail = {
    work: {
      id: 'w-1',
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      description: null,
      createdAt: new Date().toISOString(),
      revision: 1,
    },
    authors: [],
    translations: [],
    editions: [],
  }

  it('приймає кандидата у формі WorkDetailResponse', () => {
    const parsed = searchCandidatesResponseSchema.parse({
      candidates: [workDetail],
      page: 1,
      pageSize: 10,
      total: 1,
      hasMore: false,
    })

    expect(parsed.candidates[0]?.work.id).toBe('w-1')
  })

  it('не пропускає більше кандидатів, ніж найбільший розмір сторінки', () => {
    const candidates = Array.from({ length: Math.max(...SEARCH_PAGE_SIZES) + 1 }, () => workDetail)

    expect(
      searchCandidatesResponseSchema.safeParse({
        candidates,
        page: 1,
        pageSize: 50,
        total: 51,
        hasMore: true,
      }).success,
    ).toBe(false)
  })
})
