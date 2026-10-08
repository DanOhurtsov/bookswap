/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { AUTO_EXTERNAL_DELAY_MS, AUTO_LOCAL_DELAY_MS, normalizeQuery } from './auto-search'
import { useAutoSearch, type AutoSearchInput } from './use-auto-search'

/**
 * Автопошук: КОЛИ що запускається. Таймери керовані (`jest.useFakeTimers`), нічого не завантажується —
 * хук лише викликає колбеки. Мережу й екран перевіряє `AddBookScreen.spec.tsx`.
 */

const callbacks = () => ({
  onSuggest: jest.fn<void, [string]>(),
  onClear: jest.fn<void, []>(),
  onExact: jest.fn<void, [string]>(),
})

function setup(initial: Partial<AutoSearchInput> = {}) {
  const spies = callbacks()
  const hook = renderHook((props: AutoSearchInput) => useAutoSearch(props), {
    initialProps: {
      draft: '',
      urlQuery: '',
      autoMode: false,
      ...spies,
      ...initial,
    },
  })

  return {
    ...spies,
    ...hook,
    /** Набрано `draft` при тій самій адресі (за замовчуванням — порожній, без підказок). */
    type: (draft: string, extra: Partial<AutoSearchInput> = {}) => {
      hook.rerender({ draft, urlQuery: '', autoMode: false, ...spies, ...extra })
    },
  }
}

const advance = (ms: number) => {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
}

describe('useAutoSearch', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('0–1 символ: автоматичний пошук вимкнений', () => {
    const { onSuggest, type, result } = setup()

    type('к')
    advance(10_000)

    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()
    expect(result.current.localPending).toBe(false)
  })

  it('від 2 символів — підказки з нашого каталогу рівно через 350 мс, зовнішніх ще немає', () => {
    const { onSuggest, type, result } = setup()

    type('ко')
    advance(AUTO_LOCAL_DELAY_MS - 1)
    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.localPending).toBe(true)

    advance(1)
    expect(onSuggest).toHaveBeenCalledTimes(1)
    expect(onSuggest).toHaveBeenCalledWith('ко')

    // Два символи — це не поріг зовнішнього пошуку, скільки б не чекали.
    advance(10_000)
    expect(result.current.externalAsked).toBeUndefined()
  })

  it('від 3 символів — зовнішнє питання рівно через 900 мс, незалежно від локального', () => {
    const { onSuggest, type, result } = setup()

    type('коб')
    advance(AUTO_LOCAL_DELAY_MS)
    expect(onSuggest).toHaveBeenCalledTimes(1)
    expect(result.current.externalAsked).toBeUndefined()

    advance(AUTO_EXTERNAL_DELAY_MS - AUTO_LOCAL_DELAY_MS - 1)
    expect(result.current.externalAsked).toBeUndefined()

    advance(1)
    expect(result.current.externalAsked).toBe('коб')
  })

  it('адреса, яку записав локальний таймер, не відтерміновує зовнішній: це 900 мс, а не 350 + 900', () => {
    const { onSuggest, rerender, result, onClear, onExact } = setup()

    rerender({ draft: 'кобзар', urlQuery: '', autoMode: false, onSuggest, onClear, onExact })
    advance(AUTO_LOCAL_DELAY_MS)
    // Екран відобразив нову адресу — саме це перерендерення не має перезапускати таймери.
    rerender({ draft: 'кобзар', urlQuery: 'кобзар', autoMode: true, onSuggest, onClear, onExact })
    advance(AUTO_EXTERNAL_DELAY_MS - AUTO_LOCAL_DELAY_MS)

    expect(result.current.externalAsked).toBe('кобзар')
  })

  it('швидкий набір слова запускає лише один пошук після паузи', () => {
    const { onSuggest, type, result } = setup()

    for (const draft of ['ко', 'коб', 'кобз', 'кобза', 'кобзар']) {
      type(draft)
      advance(100)
    }

    expect(onSuggest).not.toHaveBeenCalled()

    advance(AUTO_LOCAL_DELAY_MS)
    expect(onSuggest).toHaveBeenCalledTimes(1)
    expect(onSuggest).toHaveBeenCalledWith('кобзар')

    advance(AUTO_EXTERNAL_DELAY_MS)
    expect(result.current.externalAsked).toBe('кобзар')
  })

  it('кожна зміна перезапускає ОБИДВА таймери', () => {
    const { onSuggest, type, result } = setup()

    type('коб')
    advance(AUTO_EXTERNAL_DELAY_MS - 1)
    type('кобз')
    advance(AUTO_EXTERNAL_DELAY_MS - 1)

    // Локальний спрацював для кожного тексту, а зовнішній жодного разу: кожна зміна його скидала.
    expect(result.current.externalAsked).toBeUndefined()
    expect(onSuggest).toHaveBeenCalledTimes(2)
    expect(onSuggest).toHaveBeenLastCalledWith('кобз')

    advance(1)
    expect(result.current.externalAsked).toBe('кобз')
  })

  it('Enter / «Шукати» до таймерів: відкладені запуски знято, дубля немає', () => {
    const { onSuggest, type, result } = setup()

    type('кобзар')
    advance(200)
    act(() => {
      result.current.cancel()
    })
    advance(10_000)

    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()
  })

  it('зміна лише зайвих пробілів не запускає нового пошуку', () => {
    const { onSuggest, rerender, onClear, onExact } = setup()

    for (const draft of ['кобзар', ' кобзар', 'кобзар  ', '  кобзар   ']) {
      rerender({ draft, urlQuery: 'кобзар', autoMode: true, onSuggest, onClear, onExact })
      advance(5_000)
    }

    expect(onSuggest).not.toHaveBeenCalled()
    expect(normalizeQuery('  Тигро   лови ')).toBe('Тигро лови')
  })

  it('виконаний повний пошук цього ж тексту не перекривається підказками', () => {
    const { onSuggest, rerender, result, onClear, onExact } = setup()

    rerender({ draft: 'кобзар', urlQuery: 'кобзар', autoMode: false, onSuggest, onClear, onExact })
    advance(10_000)

    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()
  })

  it('IME: під час композиції запитів немає, після compositionend — рахується завершений текст', () => {
    const { onSuggest, rerender, result, onClear, onExact } = setup()

    act(() => {
      result.current.composition.onCompositionStart()
    })
    rerender({ draft: 'ко', urlQuery: '', autoMode: false, onSuggest, onClear, onExact })
    rerender({ draft: 'коб', urlQuery: '', autoMode: false, onSuggest, onClear, onExact })
    advance(10_000)

    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()

    rerender({ draft: 'кобзар', urlQuery: '', autoMode: false, onSuggest, onClear, onExact })
    act(() => {
      result.current.composition.onCompositionEnd()
    })
    advance(AUTO_LOCAL_DELAY_MS)

    expect(onSuggest).toHaveBeenCalledTimes(1)
    expect(onSuggest).toHaveBeenCalledWith('кобзар')

    advance(AUTO_EXTERNAL_DELAY_MS)
    expect(result.current.externalAsked).toBe('кобзар')
  })

  it('очищення поля в режимі підказок прибирає їх з адреси; виконаний повний пошук лишається', () => {
    const suggestions = setup({ draft: 'ко', urlQuery: 'ко', autoMode: true })

    suggestions.rerender({
      draft: '',
      urlQuery: 'ко',
      autoMode: true,
      onSuggest: suggestions.onSuggest,
      onClear: suggestions.onClear,
      onExact: suggestions.onExact,
    })
    expect(suggestions.onClear).toHaveBeenCalledTimes(1)

    const full = setup({ draft: 'кобзар', urlQuery: 'кобзар', autoMode: false })

    full.rerender({
      draft: '',
      urlQuery: 'кобзар',
      autoMode: false,
      onSuggest: full.onSuggest,
      onClear: full.onClear,
      onExact: full.onExact,
    })
    expect(full.onClear).not.toHaveBeenCalled()
  })

  it('очищення скасовує таймери, що вже йшли', () => {
    const { onSuggest, type, rerender, onClear, onExact, result } = setup()

    type('кобзар')
    advance(200)
    rerender({ draft: '', urlQuery: '', autoMode: false, onSuggest, onClear, onExact })
    advance(10_000)

    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()
  })

  it('валідний ISBN-13 — без очікування й без текстового пошуку', () => {
    const { onSuggest, onExact, type, result } = setup()

    type('978-3-16-148410-0')
    expect(onExact).toHaveBeenCalledTimes(1)
    expect(onExact).toHaveBeenCalledWith('978-3-16-148410-0')

    advance(10_000)
    expect(onSuggest).not.toHaveBeenCalled()
    expect(result.current.externalAsked).toBeUndefined()
  })

  it('«1984» — не ISBN: шукається як назва', () => {
    const { onSuggest, onExact, type } = setup()

    type('1984')
    advance(AUTO_LOCAL_DELAY_MS)

    expect(onExact).not.toHaveBeenCalled()
    expect(onSuggest).toHaveBeenCalledTimes(1)
    expect(onSuggest).toHaveBeenCalledWith('1984')
  })

  it('restore відновлює зовнішнє питання без паузи (Back/Forward)', () => {
    const { result } = setup()

    act(() => {
      result.current.restore('кобзар')
    })
    expect(result.current.externalAsked).toBe('кобзар')

    act(() => {
      result.current.restore('ко')
    })
    expect(result.current.externalAsked).toBeUndefined()
  })
})
