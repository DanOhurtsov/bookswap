import { manualFieldDisplay, manualRevealOf } from './manual-field-view'
import { EMPTY_MANUAL_FORM, type ManualFormValues } from './manual-form'

function values(over: Partial<ManualFormValues> = {}): ManualFormValues {
  return { ...EMPTY_MANUAL_FORM, ...over }
}

describe('manualFieldDisplay — поле як текст (BS-76)', () => {
  it('порожня форма: усе невідоме — `null` («Додати»), а «Це переклад?» — «Не знаю»', () => {
    const display = manualFieldDisplay(EMPTY_MANUAL_FORM)

    expect(display.textKind).toBe('Не знаю')
    expect(display.authors).toEqual([])
    expect(
      Object.entries(display).filter(
        ([key, value]) => key !== 'textKind' && key !== 'authors' && value !== null,
      ),
    ).toEqual([])
  })

  it('пробіли — теж невідоме; порожні рядки авторів не показуються, порядок авторів зберігається', () => {
    const display = manualFieldDisplay(
      values({ title: '  ', publisher: ' ', authors: [' Перший ', '', '  ', 'Другий'] }),
    )

    expect(display.title).toBeNull()
    expect(display.publisher).toBeNull()
    expect(display.authors).toEqual(['Перший', 'Другий'])
  })

  it('коди показуються назвами: мови, палітурка, «Це переклад?»', () => {
    const display = manualFieldDisplay(
      values({
        lang: 'uk',
        textKind: 'TRANSLATION',
        format: 'HARDCOVER',
        translationLang: 'uk',
        translationSourceLang: 'en',
      }),
    )

    expect(display).toMatchObject({
      lang: 'українська',
      textKind: 'Так — це переклад',
      format: 'тверда',
      translationLang: 'українська',
      translationSourceLang: 'англійська',
    })
    expect(manualFieldDisplay(values({ textKind: 'ORIGINAL' })).textKind).toBe('Ні — це оригінал')
  })

  it('текст — як введено, без нормалізації: ISBN із дефісами, рік рядком', () => {
    expect(
      manualFieldDisplay(values({ isbn: '978-3-16-148410-0', firstPubYear: '1840' })),
    ).toMatchObject({ isbn: '978-3-16-148410-0', firstPubYear: '1840' })
  })
})

describe('manualRevealOf — що відкрити після невдалого «Додати до бібліотеки»', () => {
  it('невалідні поля в порядку форми та їхні розділи', () => {
    expect(
      manualRevealOf({
        firstPubYear: 'x',
        year: 'x',
        translator: 'x',
        isbn: 'x',
        title: 'x',
      }),
    ).toEqual({
      fields: ['title', 'translator', 'isbn', 'year', 'firstPubYear'],
      sections: ['translation', 'extra'],
    })
  })

  it('помилка рівня форми не відкриває нічого', () => {
    expect(manualRevealOf({ form: 'Відхилено' })).toEqual({ fields: [], sections: [] })
  })
})
