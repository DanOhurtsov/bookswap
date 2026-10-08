import type { SpellingSuggestion } from '@bookswap/shared'
import {
  IDLE_EXTERNAL_SEARCH,
  visibleSpellingSuggestion,
  type ExternalSearchState,
} from './external-search-state'
import { normalizeQuery } from './auto-search'

const local: SpellingSuggestion = { forQuery: 'Гарі Потер', text: 'Гаррі Поттер' }

const external = (
  overrides: Partial<Extract<ExternalSearchState, { status: 'ready' }>> = {},
): ExternalSearchState => ({
  status: 'ready',
  results: [],
  sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
  page: 1,
  pageSize: 8,
  more: 'NO',
  complete: true,
  ...overrides,
})

const visible = (
  draft: string,
  localSuggestion: SpellingSuggestion | undefined,
  state: ExternalSearchState,
) => visibleSpellingSuggestion(normalizeQuery(draft), localSuggestion, state, normalizeQuery)

describe('visibleSpellingSuggestion', () => {
  it('локальна підказка, поки зовнішня половина ще чекає, не питалась чи впала', () => {
    expect(visible('Гарі Потер', local, { status: 'loading' })).toBe('Гаррі Поттер')
    expect(visible('Гарі Потер', local, IDLE_EXTERNAL_SEARCH)).toBe('Гаррі Поттер')
    expect(visible('Гарі Потер', local, { status: 'failed', message: 'x' })).toBe('Гаррі Поттер')
    // Сторінка ще не завершена: зовнішнє слово не остаточне.
    expect(visible('Гарі Потер', local, external({ complete: false }))).toBe('Гаррі Поттер')
  })

  it('зовнішня відповідь по суті має останнє слово: її підказка замінює локальну', () => {
    const outside = { forQuery: 'Гарі Потер', text: 'Гаррі Поттер (джерело)' }

    expect(visible('Гарі Потер', local, external({ spellingSuggestion: outside }))).toBe(
      'Гаррі Поттер (джерело)',
    )
  })

  it('зовнішня відповідь по суті без підказки гасить локальну (кандидати суперечать)', () => {
    expect(visible('Гарі Потер', local, external())).toBeUndefined()
  })

  it('зовнішня половина, що джерел не питала (sources порожній), слова не має — діє локальна', () => {
    expect(visible('Гарі Потер', local, external({ sources: [] }))).toBe('Гаррі Поттер')
  })

  it('підказка є, лише поки текст у полі збігається з запитом, для якого її обчислено', () => {
    expect(visible('Гарі Потер а', local, { status: 'loading' })).toBeUndefined()
    expect(visible('', local, { status: 'loading' })).toBeUndefined()
    // Зайві пробіли навколо запиту різниці не роблять.
    expect(visible('  Гарі   Потер ', local, { status: 'loading' })).toBe('Гаррі Поттер')
    expect(
      visible(
        'Нова назва',
        undefined,
        external({ spellingSuggestion: { forQuery: 'Стара назва', text: 'Стара' } }),
      ),
    ).toBeUndefined()
  })

  it('без жодної підказки — нічого', () => {
    expect(visible('Кобзар', undefined, { status: 'loading' })).toBeUndefined()
  })
})
