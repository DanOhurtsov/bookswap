import {
  buildManualTarget,
  manualInitialFrom,
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
