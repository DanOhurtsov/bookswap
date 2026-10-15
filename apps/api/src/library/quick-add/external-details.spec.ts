import {
  editionFromSource,
  editionOfWorkRecord,
  needsWorkSource,
  originalLanguageOf,
} from './external-details'

const COVER = 'https://covers.openlibrary.org/b/id/1-M.jpg'

describe('editionFromSource — уточнене видання джерела', () => {
  it('підтверджене джерелом не перекривається доданим людиною; додане заповнює лише прогалини', () => {
    const edition = editionFromSource(
      {
        isbn13: '9780000000002',
        metadata: { title: 'Т', authors: [], publisher: 'Джерело', language: 'en' },
      },
      { publisher: 'Клієнт', lang: 'uk', pageCount: 320, textKind: 'TRANSLATION' },
    )

    expect(edition).toEqual({
      textKind: 'TRANSLATION',
      lang: 'en',
      publisher: 'Джерело',
      year: null,
      isbn13: '9780000000002',
      pageCount: 320,
      format: null,
      coverUrl: null,
    })
  })

  it('без уточнень нічого не вигадує: тип тексту невідомий, відсутнє — null', () => {
    expect(editionFromSource({ metadata: { title: 'Т', authors: [] } }, undefined)).toEqual({
      textKind: 'UNKNOWN',
      lang: null,
      publisher: null,
      year: null,
      isbn13: null,
      pageCount: null,
      format: null,
      coverUrl: null,
    })
  })

  it('значення джерела поза межами каталогу — невідоме, і тоді його може дати людина', () => {
    const edition = editionFromSource(
      { metadata: { title: 'Т', authors: [], publishedYear: 99_999, pageCount: 0 } },
      { year: 2001 },
    )

    expect(edition).toMatchObject({ year: 2001, pageCount: null })
  })
})

describe('editionOfWorkRecord — уточнений запис твору', () => {
  it('видання — людини; обкладинка запису лишається, поки людина її не замінила', () => {
    expect(editionOfWorkRecord({ publisher: 'В' }, COVER)).toEqual({
      publisher: 'В',
      textKind: 'UNKNOWN',
      coverUrl: COVER,
    })
  })

  it('замінена чи прибрана (null) обкладинка — рішення людини', () => {
    expect(editionOfWorkRecord({ coverUrl: 'https://e.com/c.jpg' }, COVER).coverUrl).toBe(
      'https://e.com/c.jpg',
    )
    expect(editionOfWorkRecord({ coverUrl: null }, COVER).coverUrl).toBeNull()
  })

  it('запис без обкладинки — без обкладинки', () => {
    expect(editionOfWorkRecord(undefined, undefined)).toEqual({
      textKind: 'UNKNOWN',
      coverUrl: null,
    })
  })
})

describe('needsWorkSource — коли додавання твору потребує джерела', () => {
  const direct = {}

  it('невідомий запис — завжди', () => {
    expect(needsWorkSource(direct, null)).toBe(true)
    expect(needsWorkSource({ edition: { coverUrl: null } }, null)).toBe(true)
  })

  it('пряме додавання запису з наявним виданням — ні: працює без провайдера', () => {
    expect(needsWorkSource(direct, { workId: 'w', editionId: 'e' })).toBe(false)
  })

  it('пряме додавання твору, пов’язаного лише уточненням, — так: потрібна обкладинка запису', () => {
    expect(needsWorkSource(direct, { workId: 'w', editionId: null })).toBe(true)
  })

  it('уточнення — лише коли обкладинку людина не вирішила сама', () => {
    const known = { workId: 'w', editionId: 'e' }

    expect(needsWorkSource({ edition: { publisher: 'В' } }, known)).toBe(true)
    expect(needsWorkSource({ edition: { coverUrl: null } }, known)).toBe(false)
  })
})

describe('originalLanguageOf', () => {
  it('мова оригіналу — лише мова видання, яке явно назване оригіналом', () => {
    expect(originalLanguageOf({ textKind: 'ORIGINAL', lang: 'uk' })).toBe('uk')
    expect(originalLanguageOf({ textKind: 'UNKNOWN', lang: 'uk' })).toBeNull()
    expect(originalLanguageOf({ textKind: 'TRANSLATION', lang: 'uk' })).toBeNull()
  })
})
