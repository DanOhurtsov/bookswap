import type { Translation } from '@bookswap/shared'
import {
  authorDisplayRows,
  editionFieldsDisplay,
  translationFieldsDisplay,
  workFieldsDisplay,
} from './field-display'

/**
 * BS-76: the text view of the correction forms' draft. `null` means the field is empty and offers
 * «Додати»; `false` and `0` are values, not blanks.
 */
const translation: Translation = {
  id: 't-1',
  workId: 'w-1',
  translator: 'John Weston',
  lang: 'en',
  sourceLang: 'uk',
  year: null,
  isAbridged: false,
  hasNotes: false,
  notes: null,
  editionCount: 1,
  revision: 1,
}

describe('текстовий вигляд полів виправлення', () => {
  it('твір: мова — назвою, порожні й пробільні значення — порожні', () => {
    expect(
      workFieldsDisplay({ title: 'Кобзар', origLang: 'uk', firstPubYear: 1840, description: '  ' }),
    ).toEqual({ title: 'Кобзар', origLang: 'українська', firstPubYear: '1840', description: null })
    expect(
      workFieldsDisplay({ title: '', origLang: '', firstPubYear: null, description: null }),
    ).toEqual({ title: null, origLang: null, firstPubYear: null, description: null })
  })

  it('переклад: false — «ні», а не порожнє поле; 0 — значення', () => {
    const display = translationFieldsDisplay({
      translator: 'John Weston',
      lang: 'en',
      sourceLang: 'uk',
      year: 0,
      isAbridged: false,
      hasNotes: true,
      notes: 'Рядок 1\nРядок 2',
    })

    expect(display).toEqual({
      translator: 'John Weston',
      lang: 'англійська',
      sourceLang: 'українська',
      year: '0',
      isAbridged: 'ні',
      hasNotes: 'так',
      notes: 'Рядок 1\nРядок 2',
    })
  })

  it('видання: переклад, тип тексту, палітурка й мова — зрозумілими назвами', () => {
    const display = editionFieldsDisplay(
      {
        translationId: 't-1',
        textKind: 'TRANSLATION',
        lang: 'en',
        publisher: 'Dnipro',
        year: null,
        isbn13: null,
        pageCount: 0,
        coverUrl: 'https://example.com/cover.jpg',
        format: 'HARDCOVER',
      },
      [translation],
    )

    expect(display).toEqual({
      translationId: 'John Weston (англійська)',
      textKind: 'Переклад',
      lang: 'англійська',
      publisher: 'Dnipro',
      year: null,
      isbn13: null,
      pageCount: '0',
      coverUrl: 'https://example.com/cover.jpg',
      format: 'тверда',
    })
  })

  it('видання: невідомі формат, мова й переклад — порожні; тип тексту завжди відомий', () => {
    const display = editionFieldsDisplay(
      {
        translationId: null,
        textKind: 'UNKNOWN',
        lang: null,
        publisher: null,
        year: null,
        isbn13: null,
        pageCount: null,
        coverUrl: null,
        format: '',
      },
      [],
    )

    expect(display).toMatchObject({
      translationId: null,
      textKind: 'Невідомо: оригінал чи переклад',
      lang: null,
      format: null,
    })
  })
})

describe('автори в текстовому вигляді', () => {
  const names = new Map([
    ['a-1', { name: 'Тарас Шевченко', nameLatin: null }],
    ['a-2', { name: 'Іван Франко', nameLatin: 'Ivan Franko' }],
  ])

  it('імена наявних авторів — за id, нових — із самого значення; порядок і ролі збережено', () => {
    const rows = authorDisplayRows(
      [
        { authorId: 'a-2', role: 'EDITOR' },
        { name: 'Новий Автор', nameLatin: 'Novyi Avtor', role: 'AUTHOR' },
        { authorId: 'a-1', role: 'AUTHOR' },
      ],
      names,
    )

    expect(rows.map(({ name, nameLatin, role }) => ({ name, nameLatin, role }))).toEqual([
      { name: 'Іван Франко', nameLatin: 'Ivan Franko', role: 'редактор' },
      { name: 'Новий Автор', nameLatin: 'Novyi Avtor', role: 'автор' },
      { name: 'Тарас Шевченко', nameLatin: null, role: 'автор' },
    ])
  })

  it('той самий автор двічі отримує різні ключі', () => {
    const rows = authorDisplayRows(
      [
        { authorId: 'a-1', role: 'AUTHOR' },
        { authorId: 'a-1', role: 'EDITOR' },
      ],
      names,
    )

    expect(new Set(rows.map((row) => row.key)).size).toBe(2)
  })
})
