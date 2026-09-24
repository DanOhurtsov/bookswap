import { comparableText, comparableTokens, relevanceOf } from './search-relevance'

describe('comparableText', () => {
  it('прибирає регістр, зайві пробіли та пунктуацію', () => {
    expect(comparableText('  Тигролови,   Роман!  ')).toBe('тигролови роман')
  })

  it('зрівнює варіанти апострофа', () => {
    const variants = ["П'ятірка", 'П’ятірка', 'Пʼятірка', 'П`ятірка']

    expect(new Set(variants.map(comparableText)).size).toBe(1)
  })

  it('порожній рядок не породжує порожнього токена', () => {
    expect(comparableTokens('   —  ')).toEqual([])
  })
})

describe('relevanceOf — ворота релевантності', () => {
  it('пропускає збіг за назвою', () => {
    expect(relevanceOf('Тигролови', { title: 'Тигролови' }).matched).toBe(true)
  })

  it('пропускає збіг лише за автором', () => {
    expect(relevanceOf('Багряний', { title: 'Розгром', authors: ['Іван Багряний'] }).matched).toBe(
      true,
    )
  })

  it('пропускає змішаний запит «назва + автор»', () => {
    expect(
      relevanceOf('Тигролови Багряний', { title: 'Тигролови', authors: ['Іван Багряний'] }).matched,
    ).toBe(true)
  })

  it('відхиляє книжку, де запит трапляється лише поза назвою й авторами', () => {
    // Рівно той випадок, що псував видачу: підручник згадує «Тигролови» в
    // тексті, а провайдер шукає по повному тексту.
    const textbook = {
      title: 'Українська література. 11 клас. Плани-конспекти',
      authors: ['В. В. Паращич'],
    }

    expect(relevanceOf('Тигролови', textbook).matched).toBe(false)
  })

  it('відхиляє, якщо збігся лише один токен змішаного запиту', () => {
    expect(
      relevanceOf('Тигролови Багряний', {
        title: 'Іван Багряний. Найкращі твори',
        authors: ['Іван Багряний'],
      }).matched,
    ).toBe(false)
  })

  it('підручник знаходиться за власною назвою', () => {
    expect(
      relevanceOf('Українська література плани-конспекти', {
        title: 'Українська література. 11 клас. Плани-конспекти',
        authors: ['В. В. Паращич'],
      }).matched,
    ).toBe(true)
  })

  it('допускає словозміну: «Багряного» знаходить «Багряний»', () => {
    expect(
      relevanceOf('Тигролови Багряного', { title: 'Тигролови', authors: ['Іван Багряний'] })
        .matched,
    ).toBe(true)
  })

  it('короткий токен вимагає точного збігу', () => {
    expect(relevanceOf('про', { title: 'Пробний камінь' }).matched).toBe(false)
  })

  it('порожній запит не пропускає нічого', () => {
    expect(relevanceOf('  ', { title: 'Тигролови' }).matched).toBe(false)
  })
})

describe('relevanceOf — порядок', () => {
  const scoreFor = (query: string, title: string, authors?: string[]): number =>
    relevanceOf(query, authors === undefined ? { title } : { title, authors }).score

  it('точний збіг назви вище за частковий', () => {
    expect(scoreFor('Тигролови', 'Тигролови')).toBeGreaterThan(
      scoreFor('Тигролови', 'Тигролови та інші повісті'),
    )
  })

  it('збіг у назві вище за збіг в авторі', () => {
    expect(scoreFor('Багряний', 'Багряний', [])).toBeGreaterThan(
      scoreFor('Багряний', 'Розгром', ['Іван Багряний']),
    )
  })

  it('точне слово вище за збіг лише за основою', () => {
    expect(scoreFor('Тигролови', 'Тигролови')).toBeGreaterThan(scoreFor('Тигроловах', 'Тигролови'))
  })

  it('повний збіг змішаного запиту вище за частковий', () => {
    expect(scoreFor('Тигролови Багряний', 'Тигролови', ['Іван Багряний'])).toBeGreaterThan(
      scoreFor('Тигролови Багряний', 'Тигролови', ['Хтось Інший']),
    )
  })

  it('не залежить від регістру й пунктуації запиту', () => {
    expect(scoreFor('  тигролови!  ', 'Тигролови')).toBe(scoreFor('Тигролови', 'Тигролови'))
  })
})

describe('relevanceOf — збіг за основою слова', () => {
  const matches = (query: string, title: string): boolean => relevanceOf(query, { title }).matched

  /**
   * Різні слова зі спільним початком. Кожна пара — те, що пропускало правило
   * «спільний префікс ≥ 4»: сам по собі збіг префікса нічого не означає, бо
   * будь-яке слово є початком безлічі неспоріднених довших.
   */
  it.each([
    ['правда', 'Правило'],
    ['чорний', 'Чорнило'],
    ['повість', 'Повітря'],
    ['слово', 'Словник'],
    ['місто', 'Містечко'],
    ['роман', 'Романтика'],
    ['музика', 'Музикознавство'],
    ['поет', 'Поетика'],
    ['казка', 'Казна'],
    ['wind', 'Window'],
    ['plan', 'Planet'],
    ['star', 'Start'],
    ['port', 'Portal'],
    ['king', 'Kingdom'],
    ['band', 'Bandit'],
    ['mars', 'Marsh'],
    ['казка', 'Казкар'],
    ['лісова', 'Лісовик'],
    ['книга', 'Книгарня'],
    ['part', 'Party'],
  ])('«%s» не знаходить «%s»', (query, title) => {
    expect(matches(query, title)).toBe(false)
  })

  /** Словозміна лишається: те саме слово в іншому відмінку — це збіг. */
  it.each([
    ['Багряного', 'Багряний'],
    ['Шевченка', 'Шевченко'],
    ['Кобзаря', 'Кобзар'],
    ['Тигроловів', 'Тигролови'],
    ['літератури', 'Література'],
    ['повісті', 'Повість'],
    ['книги', 'Книга'],
    ['сонця', 'Сонце'],
    ['books', 'Book'],
  ])('«%s» знаходить «%s»', (query, title) => {
    expect(matches(query, title)).toBe(true)
  })

  it('довгий спільний початок сам по собі нічого не означає', () => {
    // Вісім спільних символів — і різні слова: «-знавство» не є закінченням.
    expect(matches('книгарня', 'Книгарнязнавство')).toBe(false)
    // Шість спільних — «чорнило» не несе жодного закінчення зі списку.
    expect(matches('чорний', 'Чорнило')).toBe(false)
  })

  it('збіг за основою слабший за точний і в воротах, і в оцінці', () => {
    const exact = relevanceOf('Кобзар', { title: 'Кобзар' })
    const stem = relevanceOf('Кобзаря', { title: 'Кобзар' })

    expect(exact.matched && stem.matched).toBe(true)
    expect(exact.score).toBeGreaterThan(stem.score)
  })

  it('нормалізація апострофа не постраждала', () => {
    expect(matches("П'ятірка", 'Пʼятірка')).toBe(true)
  })
})
