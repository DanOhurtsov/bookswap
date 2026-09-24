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

function ranked(...results: ExternalSearchResult[]): RankedResult[] {
  return results.map((result, rank) => ({ result, rank }))
}

/**
 * The query every fixture below is the answer to.
 *
 * `mergeResults` needs it to order what survives; these tests are about WHICH
 * records survive, so they all use the one query the fixtures' title matches
 * and let relevance stay equal. Ordering has its own tests further down.
 */
function merge(entries: RankedResult[], limit: number): ExternalSearchResult[] {
  return mergeResults('Тигролови', entries, limit)
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
      10,
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
      10,
    )

    expect(merged).toHaveLength(2)
  })

  it('без ISBN розрізняє тиражі за роком', () => {
    const merged = merge(
      ranked(edition({ id: 'a', publishedYear: 1944 }), edition({ id: 'b', publishedYear: 2019 })),
      10,
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
      10,
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
      10,
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
      10,
    )

    // Same title, same author, same year — and still two different books on a
    // shelf. This is the case the old title+author+year key merged wrongly.
    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких видавництво невідоме', () => {
    const { publisher: _a, ...first } = edition({ id: 'a' })
    const { publisher: _b, ...second } = edition({ id: 'b' })

    const merged = merge(ranked(first, second), 10)

    // Two records agreeing only by both being silent agree about nothing.
    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких невідомий рік', () => {
    const { publishedYear: _a, ...first } = edition({ id: 'a' })
    const { publishedYear: _b, ...second } = edition({ id: 'b' })

    expect(merge(ranked(first, second), 10)).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, у яких невідомий автор', () => {
    const { authors: _a, ...first } = edition({ id: 'a' })
    const { authors: _b, ...second } = edition({ id: 'b' })

    expect(merge(ranked(first, second), 10)).toHaveLength(2)
  })

  it('НЕ зливає видання без ISBN, що розходяться мовою', () => {
    const merged = merge(
      ranked(edition({ id: 'a', language: 'uk' }), edition({ id: 'b', language: 'en' })),
      10,
    )

    expect(merged).toHaveLength(2)
  })

  it('НЕ зливає видання, де мова відома лише в одного', () => {
    const merged = merge(ranked(edition({ id: 'a', language: 'uk' }), edition({ id: 'b' })), 10)

    // Silence about the language is not agreement with 'uk'.
    expect(merged).toHaveLength(2)
  })

  it('однаковий ISBN лишається достатнім доказом попри розбіжність видавництв', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', isbn13: '9786177585113', publisher: 'Смолоскип' }),
        edition({ id: 'b', isbn13: '9786177585113', publisher: 'Smoloskyp' }),
      ),
      10,
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
      10,
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
      10,
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
      10,
    )

    // Gluing the work onto an arbitrary one of two printings would mix the
    // metadata of different editions — so all three stay separate rows.
    expect(merged).toHaveLength(3)
  })

  it('не згортає твір у тираж, коли автор невідомий хоч в одному з них', () => {
    const { authors: _dropped, ...anonymous } = edition({ id: 'a', isbn13: '9786177585113' })

    const merged = merge(
      ranked(anonymous, work({ id: 'OPEN_LIBRARY:OL1W', workExternalId: 'OL1W' })),
      10,
    )

    // A shared title alone proves nothing: books have namesakes too.
    expect(merged).toHaveLength(2)
  })

  it('зберігає порядок джерела і обрізає до ліміту', () => {
    const merged = merge(
      ranked(
        edition({ id: 'a', publishedYear: 2001 }),
        edition({ id: 'b', publishedYear: 2002 }),
        edition({ id: 'c', publishedYear: 2003 }),
      ),
      2,
    )

    expect(merged.map((result) => result.id)).toEqual(['a', 'b'])
  })

  it('порожній вхід дає порожній вихід', () => {
    expect(merge([], 10)).toEqual([])
  })

  // --- Порядок --------------------------------------------------------------

  it('точна назва йде вище за часткову, хоч би що казав порядок джерела', () => {
    const merged = mergeResults(
      'Тигролови',
      ranked(
        edition({ id: 'long', title: 'Тигролови та інші повісті', publishedYear: 2001 }),
        edition({ id: 'exact', title: 'Тигролови', publishedYear: 2002 }),
      ),
      10,
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
      10,
    )

    expect(merged[0]?.id).toBe('second')
  })
})
