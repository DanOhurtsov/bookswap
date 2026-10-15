import { buildManualTarget, EMPTY_MANUAL_FORM, type ManualFormValues } from './manual-form'
import { refineTargetOf } from './refine-target'

const COVER = 'https://covers.example/w.jpg'

const WORK_FORM: ManualFormValues = {
  ...EMPTY_MANUAL_FORM,
  title: 'Назва',
  authors: ['Автор'],
  firstPubYear: '1937',
  coverUrl: COVER,
}

const EDITION_FORM: ManualFormValues = {
  ...EMPTY_MANUAL_FORM,
  title: 'Видання',
  authors: ['Авторка'],
  isbn: '9780306406157',
  lang: 'en',
  publisher: 'Видавець',
}

function target(values: ManualFormValues, initial: ManualFormValues, record: string | null) {
  const built = buildManualTarget(values)

  if (!built.ok) throw new Error('Форма мала бути валідною')

  return refineTargetOf(built.target, initial, record)
}

describe('refineTargetOf — запис твору Open Library', () => {
  const record = 'OPEN_LIBRARY:OL1W'

  it('нічого не змінено — сам запис, без жодних даних із браузера', () => {
    expect(target(WORK_FORM, WORK_FORM, record)).toEqual({
      kind: 'EXTERNAL_WORK',
      source: 'OPEN_LIBRARY',
      externalId: 'OL1W',
    })
  })

  it('додані поля видання й переклад — доповнення до запису', () => {
    const values: ManualFormValues = {
      ...WORK_FORM,
      isbn: '9780306406157',
      year: '2019',
      textKind: 'TRANSLATION',
      lang: 'uk',
      translator: 'Перекладачка',
      translationSourceLang: 'en',
    }

    expect(target(values, WORK_FORM, record)).toEqual({
      kind: 'EXTERNAL_WORK',
      source: 'OPEN_LIBRARY',
      externalId: 'OL1W',
      edition: { textKind: 'TRANSLATION', lang: 'uk', isbn13: '9780306406157', year: 2019 },
      translation: { translator: 'Перекладачка', lang: 'uk', sourceLang: 'en' },
    })
  })

  it('прибрана обкладинка — явне null, а не повернення обкладинки запису', () => {
    expect(target({ ...WORK_FORM, coverUrl: '' }, WORK_FORM, record)).toMatchObject({
      kind: 'EXTERNAL_WORK',
      edition: { coverUrl: null },
    })
  })

  it.each([
    ['назва', { title: 'Інша назва' }],
    ['автори', { authors: ['Автор', 'Ще один'] }],
    ['рік першої публікації', { firstPubYear: '1940' }],
  ])('змінено %s — власний запис людини без звʼязку', (_name, change) => {
    expect(target({ ...WORK_FORM, ...change }, WORK_FORM, record)).toMatchObject({
      kind: 'MANUAL',
      edition: { coverUrl: COVER },
    })
  })
})

describe('refineTargetOf — видання Google Books', () => {
  const record = 'GOOGLE_BOOKS:vol-1'

  it('нічого не змінено — запис із його ISBN', () => {
    expect(target(EDITION_FORM, EDITION_FORM, record)).toEqual({
      kind: 'EXTERNAL_EDITION',
      source: 'GOOGLE_BOOKS',
      externalId: 'vol-1',
      isbn13: '9780306406157',
    })
  })

  it('заповнені прогалини й тип тексту — доповнення', () => {
    expect(
      target({ ...EDITION_FORM, pageCount: '320', textKind: 'ORIGINAL' }, EDITION_FORM, record),
    ).toEqual({
      kind: 'EXTERNAL_EDITION',
      source: 'GOOGLE_BOOKS',
      externalId: 'vol-1',
      isbn13: '9780306406157',
      edition: { textKind: 'ORIGINAL', pageCount: 320 },
    })
  })

  it.each([
    ['видавництво', { publisher: 'Інший' }],
    ['ISBN', { isbn: '9783161484100' }],
    ['мова', { lang: 'uk' }],
  ])('змінене значення запису (%s) — інше видання, власний запис', (_name, change) => {
    expect(target({ ...EDITION_FORM, ...change }, EDITION_FORM, record).kind).toBe('MANUAL')
  })

  it('рік першої публікації, якого том не підтверджує, лишає форму власним записом', () => {
    const withYear = { ...EDITION_FORM, firstPubYear: '1937' }

    expect(target(withYear, withYear, record).kind).toBe('MANUAL')
  })
})

describe('refineTargetOf — без запису', () => {
  it('звичайна ручна форма й ISBN-результат лишаються ручними', () => {
    expect(target(EDITION_FORM, EDITION_FORM, null).kind).toBe('MANUAL')
    expect(target(WORK_FORM, WORK_FORM, 'ISBNDB:x').kind).toBe('MANUAL')
    expect(target(WORK_FORM, WORK_FORM, 'OPEN_LIBRARY:OL1M').kind).toBe('MANUAL')
  })

  it('уточнення нашого твору (workId) не стає зовнішнім', () => {
    const built = buildManualTarget(WORK_FORM, 'w-1')

    if (!built.ok) throw new Error('Форма мала бути валідною')

    expect(refineTargetOf(built.target, WORK_FORM, 'OPEN_LIBRARY:OL1W').kind).toBe('MANUAL')
  })
})
