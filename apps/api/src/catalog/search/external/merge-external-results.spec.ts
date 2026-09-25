import type { ExternalSearchResult } from '@bookswap/shared'
import { mergeResults, type RankedResult } from './merge-external-results'

/**
 * A mergeable edition by default: without an ISBN the conservative rule needs
 * authors, a year AND a publisher, so the helper supplies all three. Tests that
 * check the rule itself strip them back out explicitly.
 */
function edition(overrides: Partial<ExternalSearchResult> & { id: string }): ExternalSearchResult {
  return {
    kind: 'EDITION',
    sources: ['GOOGLE_BOOKS'],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    publishedYear: 2019,
    publisher: 'Смолоскип',
    ...overrides,
  }
}

function work(overrides: Partial<ExternalSearchResult> & { id: string }): ExternalSearchResult {
  return {
    kind: 'WORK',
    sources: ['OPEN_LIBRARY'],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    firstPublishedYear: 1944,
    ...overrides,
  }
}

/** One block's worth of records — block 0 unless a test is about block order. */
function ranked(...results: ExternalSearchResult[]): RankedResult[] {
  return results.map((result, rank) => ({ result, block: 0, rank }))
}

/** The same records read as block `block`, continuing the stream's numbering. */
function rankedBlock(block: number, ...results: ExternalSearchResult[]): RankedResult[] {
  return results.map((result, index) => ({ result, block, rank: block * 10 + index }))
}

/**
 * The query every fixture below is the answer to.
 *
 * `mergeResults` needs it to order what survives; these tests are about WHICH
 * records survive, so they all use the one query the fixtures' title matches
 * and let relevance stay equal. Ordering has its own tests further down.
 */
function merge(entries: RankedResult[]): ExternalSearchResult[] {
  return mergeResults('Тигролови', entries)
}

describe('mergeResults', () => {
  it('зливає записи з однаковим ISBN, навіть якщо назви написані по-різному', () => {
    const merged = merge(
      ranked(
        edition({ id: 'GOOGLE_BOOKS:a', isbn13: '9786177585113', title: 'Тигролови' }),
        edition({
          id: 'OTHER:b',
          isbn13: '9786177585113',
          title: 'Тигролови (перевидання)',
          sources: ['OPEN_LIBRARY'],
          pageCount: 304,
        }),
      ),
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.sources).toEqual(['GOOGLE_BOOKS', 'OPEN_LIBRARY'])
    // The higher-ranked record stays the basis; the second only fills gaps.
    expect(merged[0]?.title).toBe('Тигролови')
    expect(merged[0]?.pageCount).toBe(304)
  })

  it('НЕ зливає різні видання того самого твору', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', isbn13: '9786177585113', publishedYear: 2019 }),
        edition({ id: 'b', isbn13: '9789660303072', publishedYear: 1991 }),
      ),
    )

    expect(merged).toHaveLength(2)
  })

  it('без ISBN розрізняє тиражі за роком', () => {
    const merged = merge(
      ranked(edition({ id: 'a', publishedYear: 1944 }), edition({ id: 'b', publishedYear: 2019 })),
    )

    expect(merged).toHaveLength(2)
  })

  it('зливає записи без ISBN, коли збігається вся доступна доказова база', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a' }),
        edition({
          id: 'b',
          // Same author in a different case with stray spaces is the same
          // string. Reordered name parts are NOT: "Іван Багряний" and
          // "Багряний Іван" are not treated as equal, and rightly so — the
          // normalizer has no business guessing which part is the surname.
          authors: ['  ІВАН   БАГРЯНИЙ '],
          publisher: 'смолоскип',
          sources: ['OPEN_LIBRARY'],
          pageCount: 304,
        }),
      ),
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.pageCount).toBe(304)
  })

  it('порядок авторів не впливає на злиття', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', authors: ['Ільф', 'Петров'] }),
        edition({ id: 'b', authors: ['Петров', 'Ільф'] }),
      ),
    )

    expect(merged).toHaveLength(1)
  })

  // --- The conservative rule: missing data is not evidence of a match --------

  it('НЕ зливає видання без ISBN із різними видавництвами', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', publisher: 'Смолоскип' }),
        edition({ id: 'b', publisher: 'А-ба-ба-га-ла-ма-га' }),
      ),
    )

    // Same title, same author, same year — and still two different books on a
    // shelf. This is the case the old title+author+year key merged wrongly.
    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких видавництво невідоме', () => {
    const { publisher: _a, ...first } = edition({ id: 'a' })
    const { publisher: _b, ...second } = edition({ id: 'b' })

    const merged = merge(ranked(first, second))

    // Two records agreeing only by both being silent agree about nothing.
    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких невідомий рік', () => {
    const { publishedYear: _a, ...first } = edition({ id: 'a' })
    const { publishedYear: _b, ...second } = edition({ id: 'b' })

    expect(merge(ranked(first, second))).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких невідомий автор', () => {
    const { authors: _a, ...first } = edition({ id: 'a' })
    const { authors: _b, ...second } = edition({ id: 'b' })

    expect(merge(ranked(first, second))).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, що розходяться мовою', () => {
    const merged = merge(
      ranked(edition({ id: 'a', language: 'uk' }), edition({ id: 'b', language: 'en' })),
    )

    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання, де мова відома лише в одного', () => {
    const merged = merge(ranked(edition({ id: 'a', language: 'uk' }), edition({ id: 'b' })))

    // Silence about the language is not agreement with 'uk'.
    expect(merged).toHaveLength(2)
  })

  it('однаковий ISBN лишається достатнім доказом попри розбіжність видавництв', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', isbn13: '9786177585113', publisher: 'Смолоскип' }),
        edition({ id: 'b', isbn13: '9786177585113', publisher: 'Smoloskyp' }),
      ),
    )

    // One ISBN is one printing, whatever two catalogs call its publisher.
    expect(merged).toHaveLength(1)
  })

  // --- WORK ↔ EDITION -------------------------------------------------------

  it('згортає запис про твір у ЄДИНИЙ відповідний тираж і додає workExternalId', () => {
    const merged = merge(
      ranked(
        edition({ id: 'GOOGLE_BOOKS:a', isbn13: '9786177585113' }),
        work({ id: 'OPEN_LIBRARY:OL1W', workExternalId: 'OL1W' }),
      ),
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.kind).toBe('EDITION')
    expect(merged[0]?.isbn13).toBe('9786177585113')
    expect(merged[0]?.workExternalId).toBe('OL1W')
    expect(merged[0]?.sources).toEqual(['GOOGLE_BOOKS', 'OPEN_LIBRARY'])
  })

  it('злитий запис тримає рік тиражу й рік першої публікації окремо', () => {
    const merged = merge(
      ranked(
        edition({ id: 'GOOGLE_BOOKS:a', isbn13: '9786177585113', publishedYear: 2019 }),
        work({ id: 'OPEN_LIBRARY:OL1W', workExternalId: 'OL1W', firstPublishedYear: 1944 }),
      ),
    )

    expect(merged[0]?.publishedYear).toBe(2019)
    expect(merged[0]?.firstPublishedYear).toBe(1944)
  })

  it('лишає запис про твір окремо, коли відповідних тиражів кілька', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', isbn13: '9786177585113' }),
        edition({ id: 'b', isbn13: '9789660303072' }),
        work({ id: 'OPEN_LIBRARY:OL1W', workExternalId: 'OL1W' }),
      ),
    )

    // Gluing the work onto an arbitrary one of two printings would mix the
    // metadata of different editions — so all three stay separate rows.
    expect(merged).toHaveLength(3)
  })

  it('не згортає твір у тираж, коли автор невідомий хоч в одному з них', () => {
    const { authors: _dropped, ...anonymous } = edition({ id: 'a', isbn13: '9786177585113' })

    const merged = merge(
      ranked(anonymous, work({ id: 'OPEN_LIBRARY:OL1W', workExternalId: 'OL1W' })),
    )

    // A shared title alone proves nothing: books have namesakes too.
    expect(merged).toHaveLength(2)
  })

  it('зберігає порядок джерела і НІЧОГО не обрізає', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', publishedYear: 2001 }),
        edition({ id: 'b', publishedYear: 2002 }),
        edition({ id: 'c', publishedYear: 2003 }),
      ),
    )

    // Сторінку ріже той, хто її показує. Обрізати тут означало б загубити
    // записи назавжди: наступна сторінка починається з дальшого зсуву джерела.
    expect(merged.map((result) => result.id)).toEqual(['a', 'b', 'c'])
  })

  it('запис із ПІЗНІШОГО блоку не обганяє ранішого, хоч би яка релевантність', () => {
    const merged = mergeResults('Тигролови', [
      ...rankedBlock(0, edition({ id: 'early', title: 'Тигролови та інші повісті' })),
      ...rankedBlock(1, edition({ id: 'late', title: 'Тигролови' })),
    ])

    // Точна назва сильніша — і все одно лишається другою. Інакше поява другого
    // блоку переписала б сторінку, яку людина вже відкрила, і та сама книжка
    // потрапила б на дві сторінки.
    expect(merged.map((result) => result.id)).toEqual(['early', 'late'])
  })

  it('картка, зібрана з двох блоків, лишається на місці першої зустрічі', () => {
    const shared = { title: 'Тигролови', authors: ['Іван Багряний'], isbn13: '9786177585113' }

    const merged = mergeResults('Тигролови', [
      ...rankedBlock(0, edition({ id: 'other', title: 'Розгром' })),
      ...rankedBlock(0, edition({ id: 'seen-first', ...shared })),
      ...rankedBlock(1, edition({ id: 'seen-later', ...shared, sources: ['OPEN_LIBRARY'] })),
    ])

    expect(merged.map((result) => result.id)).toEqual(['seen-first', 'other'])
    expect(merged[0]?.sources).toEqual(['GOOGLE_BOOKS', 'OPEN_LIBRARY'])
  })

  it('порожній вхід дає порожній вихід', () => {
    expect(merge([])).toEqual([])
  })

  // --- Порядок --------------------------------------------------------------

  it('точна назва йде вище за часткову, хоч би що казав порядок джерела', () => {
    const merged = mergeResults(
      'Тигролови',
      ranked(
        edition({ id: 'long', title: 'Тигролови та інші повісті', publishedYear: 2001 }),
        edition({ id: 'exact', title: 'Тигролови', publishedYear: 2002 }),
      ),
    )

    expect(merged.map((result) => result.id)).toEqual(['exact', 'long'])
  })

  it('релевантність важить більше за позицію в чужій видачі', () => {
    const merged = mergeResults(
      'Розгром',
      ranked(
        edition({ id: 'first', title: 'Тигролови', publishedYear: 2001 }),
        edition({ id: 'second', title: 'Розгром', publishedYear: 2002 }),
      ),
    )

    expect(merged[0]?.id).toBe('second')
  })

  // --- Стабільність меж сторінок (регресія №3) --------------------------------

  it('№3: друге видання в наступному блоці не розчиняє злиття WORK+EDITION з блоку 0', () => {
    const block0 = [
      ...rankedBlock(0, work({ id: 'OPEN_LIBRARY:w' })),
      ...rankedBlock(0, edition({ id: 'GOOGLE_BOOKS:e1', isbn13: '9786177585113' })),
    ]
    const block1 = rankedBlock(
      1,
      edition({ id: 'GOOGLE_BOOKS:e2', isbn13: '9789660303072', publishedYear: 1991 }),
    )

    const before = merge(block0)
    const after = merge([...block0, ...block1])

    // Раніше WORK «виринав» окремим рядком і зсував усе, що йшло за ним.
    expect(before.map((result) => result.id)).toEqual(['GOOGLE_BOOKS:e1'])
    expect(after.map((result) => result.id)).toEqual(['GOOGLE_BOOKS:e1', 'GOOGLE_BOOKS:e2'])
    expect(after[0]?.sources).toEqual(['GOOGLE_BOOKS', 'OPEN_LIBRARY'])
  })

  it('№3: WORK, що прийшов ПІЗНІШЕ за єдине видання, поглинається без зсуву рядків', () => {
    const block0 = rankedBlock(0, edition({ id: 'GOOGLE_BOOKS:e1', isbn13: '9786177585113' }))
    const block1 = rankedBlock(1, work({ id: 'OPEN_LIBRARY:w' }))

    expect(merge([...block0, ...block1]).map((result) => result.id)).toEqual(['GOOGLE_BOOKS:e1'])
  })

  it('№3: видання, що прийшло після показаного WORK, не поглинає його заднім числом', () => {
    const block0 = rankedBlock(0, work({ id: 'OPEN_LIBRARY:w' }))
    const block1 = rankedBlock(1, edition({ id: 'GOOGLE_BOOKS:e1', isbn13: '9786177585113' }))

    // Рядок WORK уже на своїй сторінці — прибрати його означало б зсунути її.
    expect(merge([...block0, ...block1]).map((result) => result.id)).toEqual([
      'OPEN_LIBRARY:w',
      'GOOGLE_BOOKS:e1',
    ])
  })

  it('властивість префіксу: пул блоків 0..k — початок пулу 0..k+1, без повторів', () => {
    const blocks: RankedResult[][] = [
      [
        ...rankedBlock(0, work({ id: 'W1', title: 'Тигролови' })),
        ...rankedBlock(0, edition({ id: 'E1', isbn13: '9786177585113' })),
        ...rankedBlock(0, edition({ id: 'E2', title: 'Розгром', isbn13: '9789660303072' })),
      ],
      [
        ...rankedBlock(1, edition({ id: 'E3', isbn13: '9786177585120', publishedYear: 1991 })),
        ...rankedBlock(1, work({ id: 'W2', title: 'Розгром', authors: ['Олександр Фадєєв'] })),
        ...rankedBlock(1, edition({ id: 'E4', isbn13: '9786177585113' })),
      ],
      rankedBlock(2, edition({ id: 'E5', title: 'Сад', isbn13: '9786177585137' })),
    ]

    let previous: string[] = []
    const seen: RankedResult[] = []

    for (const block of blocks) {
      seen.push(...block)

      const ids = merge(seen).map((result) => result.id)

      expect(ids.slice(0, previous.length)).toEqual(previous)
      expect(new Set(ids).size).toBe(ids.length)

      previous = ids
    }
  })
})
