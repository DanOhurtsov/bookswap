import {
  lookupFallbackBudget,
  lookupFallbackConcurrency,
  lookupUserAgentHeaders,
} from './lookup.config'

/**
 * R7: Open Library's guidelines ask callers to identify themselves with a
 * contact address. The rule with teeth is the second half of it — a missing
 * contact must not be papered over with a default one.
 */
describe('lookupUserAgentHeaders', () => {
  const original = process.env.CATALOG_LOOKUP_CONTACT

  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_LOOKUP_CONTACT
    else process.env.CATALOG_LOOKUP_CONTACT = original
  })

  it('додає налаштований контакт до назви застосунку', () => {
    process.env.CATALOG_LOOKUP_CONTACT = 'books@example.com'

    expect(lookupUserAgentHeaders()).toEqual({ 'User-Agent': 'BookSwap (books@example.com)' })
  })

  /**
   * Підставити сюди будь-яку адресу за замовчуванням означало б скерувати чужі
   * скарги на людину, яка про це не просила.
   */
  it('без конфігурації несе лише назву застосунку, без вигаданої адреси', () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.CATALOG_LOOKUP_CONTACT
      else process.env.CATALOG_LOOKUP_CONTACT = value

      expect(lookupUserAgentHeaders()).toEqual({ 'User-Agent': 'BookSwap' })
    }
  })
})

describe('бюджет fallback-провайдерів (R7a)', () => {
  const originalBudget = process.env.CATALOG_LOOKUP_FALLBACK_BUDGET

  afterEach(() => {
    if (originalBudget === undefined) delete process.env.CATALOG_LOOKUP_FALLBACK_BUDGET
    else process.env.CATALOG_LOOKUP_FALLBACK_BUDGET = originalBudget
  })

  it('дефолти — 50 ISBN і 4 паралельні запити', () => {
    delete process.env.CATALOG_LOOKUP_FALLBACK_BUDGET

    expect(lookupFallbackBudget()).toBe(50)
    expect(lookupFallbackConcurrency()).toBe(4)
  })

  /** Криве значення не вимикає бюджет мовчки — лишається дефолт. */
  it('нечислове або від’ємне значення не знімає обмеження', () => {
    for (const value of ['нуль', '-1', '0']) {
      process.env.CATALOG_LOOKUP_FALLBACK_BUDGET = value

      expect(lookupFallbackBudget()).toBe(50)
    }
  })
})
