/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { AUTO_EXTERNAL_DELAY_MS, AUTO_LOCAL_DELAY_MS, normalizeQuery } from './auto-search'
import { useAutoSearch, type AutoSearchInput } from './use-auto-search'

/**
 * Пошук під час введення (BS-134): КОЛИ що запускається. Таймери керовані (`jest.useFakeTimers`), нічого
 * не завантажується — хук лише викликає колбеки й каже, чию зовнішню половину вже можна питати. Мережу й
 * екран перевіряє `AddBookScreen.spec.tsx`.
 */

const callbacks = () => ({
  onSearch: jest.fn<void, [string]>(),
  onClear: jest.fn<void, []>(),
  onExact: jest.fn<void, [string]>(),
})

function setup(initial: Partial<AutoSearchInput> = {}) {
  const spies = callbacks()
  const hook = renderHook((props: AutoSearchInput) => useAutoSearch(props), {
    initialProps: {
      draft: '',
      urlQuery: '',
      ...spies,
      ...initial,
    },
  })

  return {
    ...spies,
    ...hook,
    /** Набрано `draft` при тій самій адресі (за замовчуванням — порожній, без підказок). */
    type: (draft: string, extra: Partial<AutoSearchInput> = {}) => {
      hook.rerender({ draft, urlQuery: '', ...spies, ...extra })
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
    const { onSearch, type, result } = setup()

    type('к')
    advance(10_000)

    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.externalReleased).toBe('')
    expect(result.current.localPending).toBe(false)
  })

  it('від 2 символів — повний пошук рівно через 350 мс, зовнішня половина не дозволена', () => {
    const { onSearch, type, result } = setup()

    type('ко')
    advance(AUTO_LOCAL_DELAY_MS - 1)
    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.localPending).toBe(true)

    advance(1)
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('ко')

    // Два символи — це не поріг зовнішнього пошуку, скільки б не чекали.
    advance(10_000)
    expect(result.current.externalReleased).toBe('')
  })

  it('від 3 символів — зовнішня половина дозволена рівно через 900 мс, незалежно від локального', () => {
    const { onSearch, type, result } = setup()

    type('коб')
    advance(AUTO_LOCAL_DELAY_MS)
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(result.current.externalReleased).toBe('')

    advance(AUTO_EXTERNAL_DELAY_MS - AUTO_LOCAL_DELAY_MS - 1)
    expect(result.current.externalReleased).toBe('')

    advance(1)
    expect(result.current.externalReleased).toBe('коб')
  })

  it('адреса, яку записав локальний таймер, не відтерміновує зовнішній: це 900 мс, а не 350 + 900', () => {
    const { onSearch, rerender, result, onClear, onExact } = setup()

    rerender({ draft: 'кобзар', urlQuery: '', onSearch, onClear, onExact })
    advance(AUTO_LOCAL_DELAY_MS)
    // Екран відобразив нову адресу — саме це перерендерення не має перезапускати таймери.
    rerender({ draft: 'кобзар', urlQuery: 'кобзар', onSearch, onClear, onExact })
    advance(AUTO_EXTERNAL_DELAY_MS - AUTO_LOCAL_DELAY_MS)

    expect(result.current.externalReleased).toBe('кобзар')
  })

  it('швидкий набір слова запускає лише один пошук після паузи', () => {
    const { onSearch, type, result } = setup()

    for (const draft of ['ко', 'коб', 'кобз', 'кобза', 'кобзар']) {
      type(draft)
      advance(100)
    }

    expect(onSearch).not.toHaveBeenCalled()

    advance(AUTO_LOCAL_DELAY_MS)
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('кобзар')

    advance(AUTO_EXTERNAL_DELAY_MS)
    expect(result.current.externalReleased).toBe('кобзар')
  })

  it('кожна зміна перезапускає ОБИДВА таймери', () => {
    const { onSearch, type, result } = setup()

    type('коб')
    advance(AUTO_EXTERNAL_DELAY_MS - 1)
    type('кобз')
    advance(AUTO_EXTERNAL_DELAY_MS - 1)

    // Локальний спрацював для кожного тексту, а зовнішній жодного разу: кожна зміна його скидала.
    expect(result.current.externalReleased).toBe('')
    expect(onSearch).toHaveBeenCalledTimes(2)
    expect(onSearch).toHaveBeenLastCalledWith('кобз')

    advance(1)
    expect(result.current.externalReleased).toBe('кобз')
  })

  it('Enter / «Шукати» до таймерів: відкладені запуски знято, дубля немає', () => {
    const { onSearch, type, result } = setup()

    type('кобзар')
    advance(200)
    act(() => {
      result.current.cancel()
    })
    advance(10_000)

    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.externalReleased).toBe('')
  })

  it('зміна лише зайвих пробілів не запускає нового пошуку', () => {
    const { onSearch, rerender, onClear, onExact } = setup()

    for (const draft of ['кобзар', ' кобзар', 'кобзар  ', '  кобзар   ']) {
      rerender({ draft, urlQuery: 'кобзар', onSearch, onClear, onExact })
      advance(5_000)
    }

    expect(onSearch).not.toHaveBeenCalled()
    expect(normalizeQuery('  Тигро   лови ')).toBe('Тигро лови')
  })

  it('текст, що вже є виконаним пошуком в адресі, нового пошуку не запускає', () => {
    const { onSearch, rerender, result, onClear, onExact } = setup()

    rerender({ draft: 'кобзар', urlQuery: 'кобзар', onSearch, onClear, onExact })
    advance(10_000)

    expect(onSearch).not.toHaveBeenCalled()
    // Набраний текст дозволяє свою зовнішню половину після паузи, як і будь-який інший.
    expect(result.current.externalReleased).toBe('кобзар')
  })

  it('IME: під час композиції запитів немає, після compositionend — рахується завершений текст', () => {
    const { onSearch, rerender, result, onClear, onExact } = setup()

    act(() => {
      result.current.composition.onCompositionStart()
    })
    rerender({ draft: 'ко', urlQuery: '', onSearch, onClear, onExact })
    rerender({ draft: 'коб', urlQuery: '', onSearch, onClear, onExact })
    advance(10_000)

    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.externalReleased).toBe('')

    rerender({ draft: 'кобзар', urlQuery: '', onSearch, onClear, onExact })
    act(() => {
      result.current.composition.onCompositionEnd()
    })
    advance(AUTO_LOCAL_DELAY_MS)

    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('кобзар')

    advance(AUTO_EXTERNAL_DELAY_MS)
    expect(result.current.externalReleased).toBe('кобзар')
  })

  it('поле нижче порогу пошуку: адресу з запитом просять очистити (чи очищати — вирішує адреса), порожню — ні', () => {
    const searched = setup({ draft: 'ко', urlQuery: 'ко' })

    searched.rerender({
      draft: '',
      urlQuery: 'ко',
      onSearch: searched.onSearch,
      onClear: searched.onClear,
      onExact: searched.onExact,
    })
    expect(searched.onClear).toHaveBeenCalledTimes(1)

    const empty = setup({ draft: 'к', urlQuery: '' })

    empty.rerender({
      draft: '',
      urlQuery: '',
      onSearch: empty.onSearch,
      onClear: empty.onClear,
      onExact: empty.onExact,
    })
    expect(empty.onClear).not.toHaveBeenCalled()
  })

  it('очищення скасовує таймери, що вже йшли', () => {
    const { onSearch, type, rerender, onClear, onExact, result } = setup()

    type('кобзар')
    advance(200)
    rerender({ draft: '', urlQuery: '', onSearch, onClear, onExact })
    advance(10_000)

    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.externalReleased).toBe('')
  })

  it('валідний ISBN-13 — без очікування й без текстового пошуку', () => {
    const { onSearch, onExact, type, result } = setup()

    type('978-3-16-148410-0')
    expect(onExact).toHaveBeenCalledTimes(1)
    expect(onExact).toHaveBeenCalledWith('978-3-16-148410-0')

    advance(10_000)
    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.externalReleased).toBe('')
  })

  it('«1984» — не ISBN: шукається як назва', () => {
    const { onSearch, onExact, type } = setup()

    type('1984')
    advance(AUTO_LOCAL_DELAY_MS)

    expect(onExact).not.toHaveBeenCalled()
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('1984')
  })

  it('адреса, з якою відкрито сторінку, дозволена одразу — без паузи', () => {
    const { result } = setup({ draft: 'кобзар', urlQuery: 'кобзар' })

    expect(result.current.externalReleased).toBe('кобзар')
  })

  it('release дозволяє зовнішню половину одразу, будь-якої довжини (явний пошук, Back/Forward)', () => {
    const { result } = setup()

    act(() => {
      result.current.release('кобзар')
    })
    expect(result.current.externalReleased).toBe('кобзар')

    act(() => {
      result.current.release('ко')
    })
    expect(result.current.externalReleased).toBe('ко')
  })
})
