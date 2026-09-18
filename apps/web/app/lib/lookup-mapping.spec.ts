import type { BookLookupResult } from '@bookswap/shared'
import { mapLookupResultToDraft } from './lookup-mapping'

/**
 * Cleanup Stage 7: до цієї функції lookup-мапінг був розмазаний по
 * `useState`-ініціалізаторах кроків майстра (тепер `AddBookWizard`), і саме
 * там `publishedYear` (рік видання) помилково потрапляв у чернетку
 * `Work.firstPubYear`. Тести нижче фіксують правильну семантику §6.3 напряму,
 * без рендеру React.
 */
describe('mapLookupResultToDraft', () => {
  it('lookup відсутній — усі чернетки порожні, без "undefined" чи NaN', () => {
    const draft = mapLookupResultToDraft(undefined)

    expect(draft).toEqual({
      work: { title: '', authors: [], description: '' },
      edition: { publisher: '', year: '', pageCount: '', coverUrl: '', format: undefined },
      translationLang: undefined,
    })
  })

  it('рік видання йде лише в Edition.year, а не в Work.firstPubYear', () => {
    const lookup: BookLookupResult = { title: 'Шантарам', publishedYear: 2003 }

    const draft = mapLookupResultToDraft(lookup)

    expect(draft.edition.year).toBe('2003')
    // Work-чернетка взагалі не має поля року — рік не work-level (§6.3 п.2–3).
    expect(draft.work).not.toHaveProperty('firstPubYear')
  })

  it('title і authors — лише у Work-чернетці', () => {
    const lookup: BookLookupResult = {
      title: 'Шантарам',
      authors: ['Ґреґорі Девід Робертс', 'Другий автор'],
    }

    const draft = mapLookupResultToDraft(lookup)

    expect(draft.work).toEqual({
      title: 'Шантарам',
      authors: ['Ґреґорі Девід Робертс', 'Другий автор'],
      description: '',
    })
  })

  it('publisher і coverUrl доходять до Edition-чернетки', () => {
    const lookup: BookLookupResult = {
      title: 'Т',
      publisher: 'КСД',
      description: 'Опис твору',
      pageCount: 384,
      format: 'HARDCOVER',
      coverUrl: 'https://example.com/cover.jpg',
    }

    const draft = mapLookupResultToDraft(lookup)

    expect(draft.edition.publisher).toBe('КСД')
    expect(draft.edition.coverUrl).toBe('https://example.com/cover.jpg')
  })

  it('language потрапляє лише в translationLang — не в Work і не в sourceLang', () => {
    const lookup: BookLookupResult = { title: 'Т', language: 'en' }

    const draft = mapLookupResultToDraft(lookup)

    expect(draft.translationLang).toBe('en')
    expect(draft.work).not.toHaveProperty('language')
    expect(draft.work).not.toHaveProperty('origLang')
    expect(draft.edition).not.toHaveProperty('language')
    expect(draft).not.toHaveProperty('sourceLang')
  })

  it('відсутня мова — translationLang undefined, не підмінений дефолтом', () => {
    const draft = mapLookupResultToDraft({ title: 'Т' })

    expect(draft.translationLang).toBeUndefined()
  })

  it('відсутній рік видання — порожній рядок, не "undefined" чи NaN', () => {
    const draft = mapLookupResultToDraft({ title: 'Т' })

    expect(draft.edition.year).toBe('')
    expect(draft.edition.year).not.toBe('undefined')
    expect(draft.edition.year).not.toBe('NaN')
  })

  it('відсутні автори — порожній масив, не undefined', () => {
    const draft = mapLookupResultToDraft({ title: 'Т' })

    expect(draft.work.authors).toEqual([])
  })

  it('повна відповідь — усі поля мапляться одночасно й детерміновано', () => {
    const lookup: BookLookupResult = {
      title: 'Шантарам',
      authors: ['Ґреґорі Девід Робертс'],
      publishedYear: 2003,
      language: 'en',
      publisher: 'КСД',
      description: 'Опис твору',
      pageCount: 384,
      format: 'HARDCOVER',
      coverUrl: 'https://example.com/cover.jpg',
      externalId: 'OL123456M',
    }

    expect(mapLookupResultToDraft(lookup)).toEqual({
      work: {
        title: 'Шантарам',
        authors: ['Ґреґорі Девід Робертс'],
        description: 'Опис твору',
      },
      edition: {
        publisher: 'КСД',
        year: '2003',
        pageCount: '384',
        coverUrl: 'https://example.com/cover.jpg',
        format: 'HARDCOVER',
      },
      translationLang: 'en',
    })
  })
})
