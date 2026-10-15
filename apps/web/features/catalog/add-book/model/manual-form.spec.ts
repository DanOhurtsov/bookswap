import {
  buildManualTarget,
  manualFieldError,
  manualInitialFrom,
  manualPrefillParams,
  EMPTY_MANUAL_FORM,
  type ManualFormValues,
} from './manual-form'

const VALID_ISBN = '9783161484100'

function values(over: Partial<ManualFormValues> = {}): ManualFormValues {
  return { ...EMPTY_MANUAL_FORM, title: 'Книжка', ...over }
}

describe('buildManualTarget — невідоме лишається невідомим', () => {
  it('лише назва: у запиті немає ні авторів, ні мови, ні ISBN, ні видавничих даних', () => {
    const built = buildManualTarget(values())

    expect(built).toEqual({
      ok: true,
      target: { kind: 'MANUAL', work: { title: 'Книжка' }, edition: { textKind: 'UNKNOWN' } },
    })
  })

  it('порожні поля, пробіли й порожні рядки авторів не потрапляють у запит', () => {
    const built = buildManualTarget(
      values({ authors: ['  ', ''], publisher: '   ', lang: '', format: '', coverUrl: ' ' }),
    )

    expect(built).toMatchObject({ ok: true, target: { work: { title: 'Книжка' } } })
    expect(JSON.stringify(built)).not.toContain('authors')
  })

  it('автори — у порядку введення; ISBN нормалізується; числа й формат передаються як є', () => {
    const built = buildManualTarget(
      values({
        authors: ['Перший', '', 'Другий'],
        isbn: '978-3-16-148410-0',
        year: '2020',
        pageCount: '300',
        format: 'HARDCOVER',
        firstPubYear: '1937',
        lang: 'uk',
        textKind: 'ORIGINAL',
      }),
    )

    expect(built).toEqual({
      ok: true,
      target: {
        kind: 'MANUAL',
        work: {
          title: 'Книжка',
          firstPubYear: 1937,
          authors: [{ name: 'Перший' }, { name: 'Другий' }],
        },
        edition: {
          textKind: 'ORIGINAL',
          lang: 'uk',
          isbn13: VALID_ISBN,
          year: 2020,
          pageCount: 300,
          format: 'HARDCOVER',
        },
      },
    })
  })
})

describe('buildManualTarget — помилки на полях', () => {
  it('без назви', () => {
    expect(buildManualTarget(values({ title: '  ' }))).toEqual({
      ok: false,
      errors: { title: 'Вкажіть назву' },
    })
  })

  it('з наявним твором назва не потрібна й у запит не йде', () => {
    expect(buildManualTarget(values({ title: '' }), 'work-1')).toMatchObject({
      ok: true,
      target: { work: { workId: 'work-1' } },
    })
  })

  it('помилковий ISBN — помилка поля; відсутній — дозволений', () => {
    expect(buildManualTarget(values({ isbn: '1234567890123' }))).toMatchObject({
      ok: false,
      errors: { isbn: expect.stringContaining('ISBN') },
    })
    expect(buildManualTarget(values({ isbn: '' })).ok).toBe(true)
  })

  it('нечислові рік і сторінки', () => {
    const built = buildManualTarget(values({ year: '20x0', pageCount: '1.5' }))

    expect(built).toEqual({
      ok: false,
      errors: { year: 'Потрібне ціле число', pageCount: 'Потрібне ціле число' },
    })
  })
})

describe('buildManualTarget — переклад як необовʼязковий розділ', () => {
  it('порожній розділ нічого не створює', () => {
    const built = buildManualTarget(values({ textKind: 'TRANSLATION' }))

    expect(built).toMatchObject({ ok: true })
    expect(JSON.stringify(built)).not.toContain('translation')
  })

  it('заповнений проходить чинну перевірку: без перекладача чи мови — помилки на полях розділу', () => {
    const built = buildManualTarget(
      values({ textKind: 'TRANSLATION', translationSourceLang: 'en' }),
    )

    expect(built).toMatchObject({ ok: false })
    expect(built.ok ? {} : built.errors).toHaveProperty('translator')
  })

  it('мова перекладу за замовчуванням — мова видання, яку людина вже назвала', () => {
    const built = buildManualTarget(
      values({
        textKind: 'TRANSLATION',
        lang: 'uk',
        translator: 'Олена Оніщук',
        translationSourceLang: 'en',
      }),
    )

    expect(built).toMatchObject({
      ok: true,
      target: {
        translation: { translator: 'Олена Оніщук', lang: 'uk', sourceLang: 'en' },
      },
    })
  })

  it('дані перекладу ігноруються, коли людина обрала не «переклад»', () => {
    const built = buildManualTarget(values({ textKind: 'ORIGINAL', translator: 'Хтось' }))

    expect(JSON.stringify(built)).not.toContain('translation')
  })
})

describe('manualFieldError — «Зберегти» одного поля (BS-76)', () => {
  it('ті самі правила, що й у buildManualTarget: ISBN, цілі числа, назва, контракт', () => {
    expect(manualFieldError(values({ isbn: '1234567890123' }), 'isbn')).toContain('ISBN')
    expect(manualFieldError(values({ year: '20x0' }), 'year')).toBe('Потрібне ціле число')
    expect(manualFieldError(values({ title: ' ' }), 'title')).toBe('Вкажіть назву')
    expect(manualFieldError(values({ coverUrl: 'не посилання' }), 'coverUrl')).toBe(
      'Некоректне посилання',
    )
    expect(manualFieldError(values({ firstPubYear: '99999' }), 'firstPubYear')).toBeDefined()
  })

  it('валідне поле — без помилки', () => {
    expect(manualFieldError(values({ isbn: '978-3-16-148410-0' }), 'isbn')).toBeUndefined()
    expect(manualFieldError(values({ year: '2020' }), 'year')).toBeUndefined()
  })

  it('помилки інших полів не рахуються: необовʼязкове поле не вимагає спершу назви', () => {
    const draft = values({ title: '', isbn: '1', year: '2020', publisher: 'Наука' })

    expect(manualFieldError(draft, 'year')).toBeUndefined()
    expect(manualFieldError(draft, 'publisher')).toBeUndefined()
    expect(manualFieldError(draft, 'title')).toBe('Вкажіть назву')
    expect(manualFieldError(draft, 'isbn')).toContain('ISBN')
  })

  it('розділ перекладу: кожне поле відповідає лише за свою помилку', () => {
    const draft = values({ textKind: 'TRANSLATION', translationSourceLang: 'en' })

    expect(manualFieldError(draft, 'translationSourceLang')).toBeUndefined()
    expect(manualFieldError(draft, 'translator')).toBeDefined()
  })

  it('з наявним твором назва не потрібна', () => {
    expect(manualFieldError(values({ title: '' }), 'title', 'work-1')).toBeUndefined()
  })
})

describe('manualInitialFrom', () => {
  it('підставляє відоме з адреси: назву, ISBN, авторів, рік', () => {
    const initial = manualInitialFrom(
      new URLSearchParams(
        'mode=manual&title=Назва&isbn=9783161484100&author=А&author=Б&firstPubYear=1937',
      ),
    )

    expect(initial).toMatchObject({
      title: 'Назва',
      isbn: VALID_ISBN,
      authors: ['А', 'Б'],
      firstPubYear: '1937',
    })
  })

  it('без параметрів — порожня форма з одним полем автора', () => {
    expect(manualInitialFrom(new URLSearchParams())).toEqual(EMPTY_MANUAL_FORM)
  })
})

describe('manualPrefillParams → manualInitialFrom (BS-114)', () => {
  it('every known field reaches its own form field; work and edition years stay apart', () => {
    const values = manualInitialFrom(
      manualPrefillParams({
        title: 'Назва',
        authors: ['Перший', 'Другий'],
        firstPubYear: 1937,
        isbn: '9783161484100',
        lang: 'uk',
        publisher: 'Видавець',
        year: 2019,
        pageCount: 320,
        format: 'HARDCOVER',
        coverUrl: 'https://covers.example/1.jpg',
      }),
    )

    expect(values).toEqual({
      ...EMPTY_MANUAL_FORM,
      title: 'Назва',
      authors: ['Перший', 'Другий'],
      firstPubYear: '1937',
      isbn: '9783161484100',
      lang: 'uk',
      publisher: 'Видавець',
      year: '2019',
      pageCount: '320',
      format: 'HARDCOVER',
      coverUrl: 'https://covers.example/1.jpg',
    })
  })

  it('unknown values are not written at all', () => {
    expect(manualPrefillParams({ title: 'Назва', year: undefined, publisher: '' }).toString()).toBe(
      `title=${encodeURIComponent('Назва')}`,
    )
  })

  it('a language or binding that is not a real one stays unknown instead of being guessed', () => {
    const values = manualInitialFrom(new URLSearchParams('lang=xx&format=SCROLL'))

    expect(values.lang).toBe('')
    expect(values.format).toBe('')
  })

  it('what is still known is still carried into the contract: the full target from a prefilled form', () => {
    const values = manualInitialFrom(
      manualPrefillParams({
        title: 'Назва',
        authors: ['Автор'],
        firstPubYear: 1937,
        isbn: '9783161484100',
        lang: 'en',
        publisher: 'Видавець',
        year: 2019,
        pageCount: 320,
        format: 'PAPERBACK',
        coverUrl: 'https://covers.example/1.jpg',
      }),
    )

    expect(buildManualTarget(values)).toEqual({
      ok: true,
      target: {
        kind: 'MANUAL',
        work: { title: 'Назва', firstPubYear: 1937, authors: [{ name: 'Автор' }] },
        edition: {
          textKind: 'UNKNOWN',
          lang: 'en',
          isbn13: '9783161484100',
          publisher: 'Видавець',
          year: 2019,
          pageCount: 320,
          format: 'PAPERBACK',
          coverUrl: 'https://covers.example/1.jpg',
        },
      },
    })
  })
})
