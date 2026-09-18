import { bookLookupRequestSchema, bookLookupResultSchema } from './lookup'

describe('bookLookupRequestSchema', () => {
  it('нормалізує ISBN-13 із дефісами й пробілами', () => {
    expect(bookLookupRequestSchema.parse({ isbn: '978-3-16-148410-0' }).isbn).toBe('9783161484100')
  })

  it('відхиляє ISBN з невірною контрольною сумою', () => {
    expect(bookLookupRequestSchema.safeParse({ isbn: '9783161484101' }).success).toBe(false)
  })

  it('відхиляє щось, що не є ISBN-13 взагалі', () => {
    expect(bookLookupRequestSchema.safeParse({ isbn: 'not-an-isbn' }).success).toBe(false)
  })
})

describe('bookLookupResultSchema', () => {
  it('приймає лише title — решта полів опційна', () => {
    const parsed = bookLookupResultSchema.safeParse({ title: 'Шантарам' })

    expect(parsed.success).toBe(true)
  })

  it('відхиляє відповідь без title', () => {
    expect(bookLookupResultSchema.safeParse({ authors: ['Хтось'] }).success).toBe(false)
  })

  it('приймає повну відповідь', () => {
    const full = {
      title: 'Шантарам',
      authors: ['Ґреґорі Девід Робертс'],
      publishedYear: 2003,
      language: 'en',
      publisher: 'КСД',
      description: 'Опис твору',
      pageCount: 384,
      format: 'HARDCOVER',
      coverUrl: 'https://example.com/cover.jpg',
      source: 'GOOGLE_BOOKS',
      externalId: 'OL123456M',
      workExternalId: 'OL987654W',
    }

    expect(bookLookupResultSchema.parse(full)).toEqual(full)
  })

  it('відхиляє невідоме джерело та невалідні фізичні поля видання', () => {
    expect(
      bookLookupResultSchema.safeParse({
        title: 'Шантарам',
        source: 'BOOK_STORE',
        pageCount: 0,
        format: 'SCROLL',
      }).success,
    ).toBe(false)
  })

  it('відхиляє мову, що не є кодом ISO 639-1 (§6.3 п.7: не підміняти невідоме значення)', () => {
    expect(bookLookupResultSchema.safeParse({ title: 'Шантарам', language: 'eng' }).success).toBe(
      false,
    )
  })
})
