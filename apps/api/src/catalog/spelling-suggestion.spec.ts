import type { SpellingCandidate } from './catalog.search'
import {
  SPELLING_MIN_MARGIN,
  SPELLING_MIN_SCORE,
  chooseSpellingSuggestion,
} from './spelling-suggestion'

/**
 * Контрольні приклади. Оцінки — не вигадані: це `similarity(bookswap_norm(назва), bookswap_norm(запит))`
 * з реального `pg_trgm` (PostgreSQL 17). Поріг — не «відсоток впевненості», а межа між «схоже на цю
 * назву з помилкою» і «просто трохи схоже».
 */
const candidate = (text: string, score: number): SpellingCandidate => ({
  text,
  textNorm: text.toLowerCase(),
  score,
})

describe('chooseSpellingSuggestion', () => {
  it.each([
    ['гарі потер', 'Гаррі Поттер', 0.6],
    ['кобзарь', 'Кобзар', 0.667],
    ['шантараам', 'Шантарам', 0.727],
    ['джордж орвелль', 'Джордж Орвелл', 0.7],
    ['лисова пісня', 'Лісова пісня', 0.625],
    ['шентарам', 'Шантарам', 0.5],
  ])('помилка в написанні «%s» → «%s»', (term, title, score) => {
    expect(chooseSpellingSuggestion(term, false, [candidate(title, score)])).toBe(title)
  })

  it('правильний запит (є частковий або точний збіг) підказки не має', () => {
    expect(chooseSpellingSuggestion('кобзар', true, [candidate('Кобзар', 1)])).toBeUndefined()
    // «Орвел» — підрядок «Джордж Орвелл» (0.33), а «Орвелл» схожий ще більше: обидва — звичайний збіг.
    expect(chooseSpellingSuggestion('орвел', true, [candidate('Орвелл', 0.625)])).toBeUndefined()
  })

  it('недостатньо схоже: «Стівен Кінг» ≠ «Стефан Кінг» (0.41)', () => {
    expect(
      chooseSpellingSuggestion('стівен кінг', false, [candidate('Стефан Кінг', 0.412)]),
    ).toBeUndefined()
  })

  it('поріг: рівно SPELLING_MIN_SCORE — підказка, трохи нижче — ні', () => {
    expect(
      chooseSpellingSuggestion('abcdef', false, [candidate('Abcdeg', SPELLING_MIN_SCORE)]),
    ).toBe('Abcdeg')
    expect(
      chooseSpellingSuggestion('abcdef', false, [candidate('Abcdeg', SPELLING_MIN_SCORE - 0.01)]),
    ).toBeUndefined()
  })

  it('неоднозначно: «Гарі Потер» схоже і на «Гаррі Поттер» (0.60), і на «Дарі Потер» (0.57)', () => {
    expect(
      chooseSpellingSuggestion('гарі потер', false, [
        candidate('Гаррі Поттер', 0.6),
        candidate('Дарі Потер', 0.571),
      ]),
    ).toBeUndefined()
  })

  it('запас між першим і другим: менший за SPELLING_MIN_MARGIN — без підказки, достатній — підказка', () => {
    expect(
      chooseSpellingSuggestion('гарі потер', false, [
        candidate('Гаррі Поттер', 0.7),
        candidate('Дарі Потер', 0.7 - SPELLING_MIN_MARGIN + 0.001),
      ]),
    ).toBeUndefined()
    expect(
      chooseSpellingSuggestion('гарі потер', false, [
        candidate('Гаррі Поттер', 0.7),
        candidate('Дарі Потер', 0.5),
      ]),
    ).toBe('Гаррі Поттер')
  })

  it.each(['', 'кн', 'гар'])('короткий запит «%s» підказки не має', (term) => {
    expect(chooseSpellingSuggestion(term, false, [candidate('Гаррі Поттер', 0.9)])).toBeUndefined()
  })

  it('недописаний запит — не помилка: «гаррі поттер філософський» (0.74) → без підказки', () => {
    expect(
      chooseSpellingSuggestion('гаррі поттер філософський', false, [
        candidate('Гаррі Поттер і філософський камінь', 0.743),
      ]),
    ).toBeUndefined()
  })

  it('немає кандидатів — немає підказки', () => {
    expect(chooseSpellingSuggestion('щось незрозуміле', false, [])).toBeUndefined()
  })

  describe('кандидати з кількох джерел', () => {
    it('кілька видань однієї назви (і різне написання регістру чи розділових знаків) — один кандидат, а не неоднозначність', () => {
      expect(
        chooseSpellingSuggestion('гарі потер', false, [
          candidate('Гаррі Поттер', 0.6),
          candidate('Гаррі Поттер', 0.6),
          candidate('ГАРРІ ПОТТЕР.', 0.6),
          candidate('Гаррі  Поттер', 0.6),
        ]),
      ).toBe('Гаррі Поттер')
    })

    it('за рівних оцінок лишається перший (наш) запис', () => {
      expect(
        chooseSpellingSuggestion('гарі потер', false, [
          candidate('Гаррі Поттер', 0.6),
          candidate('гаррі поттер', 0.6),
        ]),
      ).toBe('Гаррі Поттер')
    })

    it('суперечливі кандидати з різних джерел — без підказки', () => {
      expect(
        chooseSpellingSuggestion('гарі потер', false, [
          candidate('Гаррі Поттер', 0.6),
          candidate('Дарі Потер', 0.571),
        ]),
      ).toBeUndefined()
    })

    it('джерела пишуть запит так само, як людина (підрядок) — виправляти нема за чим', () => {
      expect(
        chooseSpellingSuggestion('гаррі потер', false, [
          candidate('Гаррі Потер і філософський камінь', 0.3),
          candidate('Гаррі Поттер', 0.786),
        ]),
      ).toBeUndefined()
    })

    it('слабкий кандидат із джерела не заважає єдиному впевненому', () => {
      expect(
        chooseSpellingSuggestion('гарі потер', false, [
          candidate('Гаррі Поттер', 0.6),
          candidate('Гаррі Поттер і таємна кімната', 0.29),
        ]),
      ).toBe('Гаррі Поттер')
    })
  })
})
