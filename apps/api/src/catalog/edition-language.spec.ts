import {
  editionKindWhere,
  editionLanguageWhere,
  planMergeLanguage,
  planWorkOriginalLangChange,
  resolveEditionText,
  type EditionTextContext,
  type EditionTextState,
} from './edition-language'

/**
 * Матриця переходів і правила мови (docs/plan/fast-book-add.md, ред. 2, §1; 2.1): усе без БД. Кожен рядок
 * таблиці з плану — окремий тест; конфлікт завжди явний, введена мова не відкидається мовчки.
 */

const UNKNOWN_EN: EditionTextState = { textKind: 'UNKNOWN', lang: 'de', translationId: null }
const original = (lang: string | null): EditionTextState => ({
  textKind: 'ORIGINAL',
  lang,
  translationId: null,
})
const translated = (lang: string, translationId = 't-1'): EditionTextState => ({
  textKind: 'TRANSLATION',
  lang,
  translationId,
})

describe('resolveEditionText — створення', () => {
  it('оригінал на творі з відомою мовою: мова береться з твору', () => {
    expect(resolveEditionText(undefined, { textKind: 'ORIGINAL' }, { workOrigLang: 'en' })).toEqual(
      { ok: true, state: { textKind: 'ORIGINAL', lang: 'en', translationId: null } },
    )
  })

  it('оригінал на творі з невідомою мовою: введена мова зберігається, твір не змінюється', () => {
    expect(
      resolveEditionText(undefined, { textKind: 'ORIGINAL', lang: 'uk' }, { workOrigLang: null }),
    ).toEqual({ ok: true, state: { textKind: 'ORIGINAL', lang: 'uk', translationId: null } })
  })

  it('оригінал без жодної мови: мова лишається невідомою', () => {
    expect(resolveEditionText(undefined, { textKind: 'ORIGINAL' }, { workOrigLang: null })).toEqual(
      { ok: true, state: { textKind: 'ORIGINAL', lang: null, translationId: null } },
    )
  })

  it('оригінал з відомою мовою твору: інша введена мова — конфлікт, а не мовчазна заміна', () => {
    expect(
      resolveEditionText(undefined, { textKind: 'ORIGINAL', lang: 'de' }, { workOrigLang: 'en' }),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
  })

  it('переклад із звʼязком бере мову перекладу', () => {
    expect(
      resolveEditionText(
        undefined,
        { translationId: 't-1' },
        { workOrigLang: 'en', targetTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: translated('uk') })
  })

  it('введена мова, що збігається з мовою перекладу, — ок; інша — конфлікт', () => {
    const context: EditionTextContext = { workOrigLang: 'en', targetTranslation: { lang: 'uk' } }

    expect(
      resolveEditionText(undefined, { translationId: 't-1', lang: 'uk' }, context),
    ).toMatchObject({
      ok: true,
    })
    expect(
      resolveEditionText(undefined, { translationId: 't-1', lang: 'pl' }, context),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
  })

  it('невідомий текст зберігає мову видання, не повʼязану з твором', () => {
    expect(
      resolveEditionText(undefined, { textKind: 'UNKNOWN', lang: 'de' }, { workOrigLang: 'en' }),
    ).toEqual({ ok: true, state: { textKind: 'UNKNOWN', lang: 'de', translationId: null } })
  })

  it('переклад без звʼязку: тип і мова зберігаються як введено', () => {
    expect(
      resolveEditionText(
        undefined,
        { textKind: 'TRANSLATION', lang: 'uk' },
        { workOrigLang: 'en' },
      ),
    ).toEqual({ ok: true, state: { textKind: 'TRANSLATION', lang: 'uk', translationId: null } })
  })

  it('без жодних відомостей: невідомий текст, невідома мова', () => {
    expect(resolveEditionText(undefined, {}, { workOrigLang: null })).toEqual({
      ok: true,
      state: { textKind: 'UNKNOWN', lang: null, translationId: null },
    })
  })
})

describe('resolveEditionText — переходи UNKNOWN ↔ ORIGINAL ↔ TRANSLATION', () => {
  it('UNKNOWN → ORIGINAL на творі з відомою мовою: мова невідома заповнюється', () => {
    expect(
      resolveEditionText(
        { textKind: 'UNKNOWN', lang: null, translationId: null },
        { textKind: 'ORIGINAL' },
        { workOrigLang: 'en' },
      ),
    ).toEqual({ ok: true, state: original('en') })
  })

  it('UNKNOWN → ORIGINAL: відома мова видання, відмінна від мови оригіналу, — конфлікт', () => {
    expect(
      resolveEditionText(UNKNOWN_EN, { textKind: 'ORIGINAL' }, { workOrigLang: 'en' }),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
  })

  it('UNKNOWN → ORIGINAL на творі без мови: мова видання зберігається', () => {
    expect(
      resolveEditionText(UNKNOWN_EN, { textKind: 'ORIGINAL' }, { workOrigLang: null }),
    ).toEqual({ ok: true, state: original('de') })
  })

  it('ORIGINAL → UNKNOWN: мова зберігається', () => {
    expect(
      resolveEditionText(original('en'), { textKind: 'UNKNOWN' }, { workOrigLang: 'en' }),
    ).toEqual({ ok: true, state: { textKind: 'UNKNOWN', lang: 'en', translationId: null } })
  })

  it('ORIGINAL → TRANSLATION без звʼязку: мова зберігається', () => {
    expect(
      resolveEditionText(original('en'), { textKind: 'TRANSLATION' }, { workOrigLang: 'en' }),
    ).toEqual({ ok: true, state: { textKind: 'TRANSLATION', lang: 'en', translationId: null } })
  })

  it('TRANSLATION без звʼязку → ORIGINAL: мова мусить збігатися з мовою оригіналу', () => {
    expect(
      resolveEditionText(
        { textKind: 'TRANSLATION', lang: 'uk', translationId: null },
        { textKind: 'ORIGINAL' },
        { workOrigLang: 'en' },
      ),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
  })
})

describe('resolveEditionText — привʼязування й відвʼязування перекладу', () => {
  it('привʼязування до оригіналу: мова, що була виведена з твору, слідує за перекладом', () => {
    expect(
      resolveEditionText(
        original('en'),
        { translationId: 't-1' },
        { workOrigLang: 'en', targetTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: translated('uk') })
  })

  it('привʼязування до видання з НЕЗАЛЕЖНО відомою мовою, що суперечить перекладу, — конфлікт', () => {
    expect(
      resolveEditionText(
        UNKNOWN_EN,
        { translationId: 't-1' },
        { workOrigLang: 'en', targetTranslation: { lang: 'uk' } },
      ),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
  })

  it('…але явно задана мова, що збігається з перекладом, цей конфлікт знімає', () => {
    expect(
      resolveEditionText(
        UNKNOWN_EN,
        { translationId: 't-1', lang: 'uk' },
        { workOrigLang: 'en', targetTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: translated('uk') })
  })

  it('невідома мова заповнюється мовою перекладу, тип стає TRANSLATION', () => {
    expect(
      resolveEditionText(
        { textKind: 'UNKNOWN', lang: null, translationId: null },
        { translationId: 't-1' },
        { workOrigLang: null, targetTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: translated('uk') })
  })

  it('заміна одного перекладу іншим: мова слідує за новим, а не блокується старим', () => {
    expect(
      resolveEditionText(
        translated('de', 't-1'),
        { translationId: 't-2' },
        {
          workOrigLang: 'en',
          targetTranslation: { lang: 'pl' },
          currentTranslation: { lang: 'de' },
        },
      ),
    ).toEqual({ ok: true, state: translated('pl', 't-2') })
  })

  it('видання з перекладом: інший тип тексту без відвʼязування — 422-помилка', () => {
    expect(
      resolveEditionText(
        translated('uk'),
        { textKind: 'ORIGINAL' },
        { workOrigLang: 'uk', currentTranslation: { lang: 'uk' } },
      ),
    ).toMatchObject({ ok: false, reason: 'KIND_REQUIRES_UNLINK' })
    expect(
      resolveEditionText(
        translated('uk'),
        { translationId: 't-1', textKind: 'UNKNOWN' },
        {
          workOrigLang: 'uk',
          targetTranslation: { lang: 'uk' },
          currentTranslation: { lang: 'uk' },
        },
      ),
    ).toMatchObject({ ok: false, reason: 'KIND_REQUIRES_UNLINK' })
  })

  it('відвʼязування без типу: стара семантика «оригінал», мова з твору', () => {
    expect(
      resolveEditionText(
        translated('uk'),
        { translationId: null },
        { workOrigLang: 'en', currentTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: original('en') })
  })

  it('відвʼязування без типу, коли мова оригіналу невідома, — потрібен явний тип', () => {
    expect(
      resolveEditionText(
        translated('uk'),
        { translationId: null },
        { workOrigLang: null, currentTranslation: { lang: 'uk' } },
      ),
    ).toMatchObject({ ok: false, reason: 'UNLINK_NEEDS_KIND' })
  })

  it.each(['UNKNOWN', 'TRANSLATION'] as const)(
    'відвʼязування з явним типом %s: мова видання зберігається',
    (textKind) => {
      expect(
        resolveEditionText(
          translated('uk'),
          { translationId: null, textKind },
          { workOrigLang: null, currentTranslation: { lang: 'uk' } },
        ),
      ).toEqual({ ok: true, state: { textKind, lang: 'uk', translationId: null } })
    },
  )

  it('відвʼязування з явним ORIGINAL: мова мусить збігатися з мовою оригіналу', () => {
    expect(
      resolveEditionText(
        translated('uk'),
        { translationId: null, textKind: 'ORIGINAL' },
        { workOrigLang: 'en', currentTranslation: { lang: 'uk' } },
      ),
    ).toMatchObject({ ok: false, reason: 'LANGUAGE_CONFLICT' })
    expect(
      resolveEditionText(
        translated('uk'),
        { translationId: null, textKind: 'ORIGINAL', lang: 'en' },
        { workOrigLang: 'en', currentTranslation: { lang: 'uk' } },
      ),
    ).toEqual({ ok: true, state: original('en') })
  })
})

describe('planWorkOriginalLangChange — зміна Work.origLang', () => {
  const edition = (
    id: string,
    kind: 'ORIGINAL' | 'TRANSLATION' | 'UNKNOWN',
    lang: string | null,
  ) => ({
    id,
    kind,
    lang,
  })

  it('мова оригіналу невідома, видання вже має нову мову (uk → uk): успіх без змін', () => {
    expect(planWorkOriginalLangChange([edition('e1', 'ORIGINAL', 'uk')], null, 'uk')).toEqual({
      ok: true,
      updates: [],
    })
  })

  it('мова оригіналу невідома, видання має ІНШУ відому мову (en → uk): конфлікт', () => {
    expect(planWorkOriginalLangChange([edition('e1', 'ORIGINAL', 'en')], null, 'uk')).toEqual({
      ok: false,
      conflictEditionIds: ['e1'],
    })
  })

  it('невідома мова видання заповнюється новою', () => {
    expect(planWorkOriginalLangChange([edition('e1', 'ORIGINAL', null)], null, 'uk')).toEqual({
      ok: true,
      updates: [{ id: 'e1', lang: 'uk' }],
    })
  })

  it('видання, що мало колишню мову оригіналу, переходить на нову', () => {
    expect(planWorkOriginalLangChange([edition('e1', 'ORIGINAL', 'en')], 'en', 'uk')).toEqual({
      ok: true,
      updates: [{ id: 'e1', lang: 'uk' }],
    })
  })

  it('переклади й UNKNOWN зі своєю мовою зміна мови оригіналу не торкається', () => {
    expect(
      planWorkOriginalLangChange(
        [edition('t', 'TRANSLATION', 'de'), edition('u', 'UNKNOWN', 'fr')],
        'en',
        'uk',
      ),
    ).toEqual({ ok: true, updates: [] })
  })

  it('очищення мови оригіналу видань не торкається', () => {
    expect(planWorkOriginalLangChange([edition('e1', 'ORIGINAL', 'en')], 'en', null)).toEqual({
      ok: true,
      updates: [],
    })
  })

  it('один конфліктний оригінал скасовує ВЕСЬ план: часткових оновлень не буде', () => {
    expect(
      planWorkOriginalLangChange(
        [edition('ok', 'ORIGINAL', null), edition('bad', 'ORIGINAL', 'fr')],
        null,
        'uk',
      ),
    ).toEqual({ ok: false, conflictEditionIds: ['bad'] })
  })
})

describe('planMergeLanguage — злиття творів', () => {
  const facts = (kind: 'ORIGINAL' | 'TRANSLATION' | 'UNKNOWN', lang: string | null) => ({
    id: 'e',
    kind,
    lang,
  })

  it('ціль без відомої мови: мова видання лишається своєю — вона не виводиться з твору', () => {
    expect(planMergeLanguage(facts('ORIGINAL', 'en'), null)).toEqual({ action: 'KEEP' })
    expect(planMergeLanguage(facts('ORIGINAL', null), null)).toEqual({ action: 'KEEP' })
  })

  it('ціль має мову, видання — невідому: заповнюється мовою цілі', () => {
    expect(planMergeLanguage(facts('ORIGINAL', null), 'uk')).toEqual({ action: 'SET', lang: 'uk' })
  })

  it('однакові мови — без змін', () => {
    expect(planMergeLanguage(facts('ORIGINAL', 'uk'), 'uk')).toEqual({ action: 'KEEP' })
  })

  it('різні ВІДОМІ мови — конфлікт, а не мовчазна зміна', () => {
    expect(planMergeLanguage(facts('ORIGINAL', 'en'), 'uk')).toEqual({ action: 'CONFLICT' })
  })

  it.each(['TRANSLATION', 'UNKNOWN'] as const)('%s переноситься без змін', (kind) => {
    expect(planMergeLanguage(facts(kind, 'en'), 'uk')).toEqual({ action: 'KEEP' })
  })
})

describe('умови Prisma для фільтрів', () => {
  it('мова — власне поле видання', () => {
    expect(editionLanguageWhere('uk')).toEqual({ lang: 'uk' })
  })

  it('оригінал і переклад — взаємовиключні, UNKNOWN не потрапляє в жоден', () => {
    expect(editionKindWhere('ORIGINAL')).toEqual({ textKind: 'ORIGINAL' })
    expect(editionKindWhere('TRANSLATED')).toEqual({ textKind: 'TRANSLATION' })
  })
})
