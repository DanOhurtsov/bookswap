import {
  byEditionOrder,
  toEdition,
  toEditionRevisionSnapshot,
  toTranslationRevisionSnapshot,
  toViewerCapabilities,
  toWork,
  toWorkAuthors,
  toWorkRevisionSnapshot,
  type EditionRow,
} from './catalog.mapper'
import { escapeLikePattern } from './search-text'
import type { Edition } from '@bookswap/shared'

const work = {
  id: 'work-1',
  title: 'Гобіт, або Туди і звідти',
  origLang: 'en',
  firstPubYear: 1937,
  description: null,
  createdAt: new Date('2026-01-01T12:00:00.000Z'),
  revision: 1,
}

function editionRow(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    id: 'edition-1',
    workId: 'work-1',
    translationId: 'translation-1',
    publisher: 'Астролябія',
    year: 2021,
    isbn13: '9786176642411',
    pageCount: 384,
    coverUrl: null,
    format: 'PAPERBACK',
    textKind: 'TRANSLATION',
    lang: 'uk',
    translation: { lang: 'uk', translator: 'Олена Оніщук' },
    revision: 1,
    ...overrides,
  }
}

describe('toWork', () => {
  it('віддає дату як ISO-рядок', () => {
    expect(toWork(work).createdAt).toBe('2026-01-01T12:00:00.000Z')
  })

  it('не тягне за собою полів рейтингу — §10 приїде на етапі оцінок', () => {
    const projected = toWork({ ...work })

    expect(projected).not.toHaveProperty('ratingAvg')
    expect(projected).not.toHaveProperty('titleNorm')
  })
})

describe('toWorkAuthors', () => {
  it('упорядковує за position — єдиним джерелом порядку (R10a)', () => {
    const authors = toWorkAuthors([
      { role: 'ILLUSTRATOR', position: 2, author: { id: 'a-3', name: 'Ярина', nameLatin: null } },
      { role: 'AUTHOR', position: 1, author: { id: 'a-2', name: 'Богдан', nameLatin: null } },
      { role: 'AUTHOR', position: 0, author: { id: 'a-1', name: 'Андрій', nameLatin: null } },
    ])

    expect(authors.map((author) => author.name)).toEqual(['Андрій', 'Богдан', 'Ярина'])
    expect(authors.map((author) => author.position)).toEqual([0, 1, 2])
  })

  /**
   * R10a: роль не перевизначає ручний порядок. Раніше `toWorkAuthors` сортувала
   * спершу за роллю — це навмисно більше не так: клієнт міг поставити
   * ILLUSTRATOR першим, і `position` це зберігає.
   */
  it('роль не перевизначає position, навіть якщо це виглядає «не за роллю»', () => {
    const authors = toWorkAuthors([
      { role: 'AUTHOR', position: 1, author: { id: 'a-2', name: 'Богдан', nameLatin: null } },
      { role: 'ILLUSTRATOR', position: 0, author: { id: 'a-1', name: 'Андрій', nameLatin: null } },
    ])

    expect(authors.map((author) => author.role)).toEqual(['ILLUSTRATOR', 'AUTHOR'])
  })

  it('роль належить звʼязку, а не людині: та сама людина може бути двічі', () => {
    const authors = toWorkAuthors([
      { role: 'AUTHOR', position: 0, author: { id: 'a-1', name: 'Андрій', nameLatin: null } },
      { role: 'ILLUSTRATOR', position: 1, author: { id: 'a-1', name: 'Андрій', nameLatin: null } },
    ])

    expect(authors).toHaveLength(2)
    expect(authors.map((author) => author.role)).toEqual(['AUTHOR', 'ILLUSTRATOR'])
  })
})

describe('toEdition', () => {
  it('бере мову й перекладача з перекладу', () => {
    const edition = toEdition(editionRow())

    expect(edition.lang).toBe('uk')
    expect(edition.translator).toBe('Олена Оніщук')
  })

  it('видання мовою оригіналу: мова з твору, перекладача немає (§4.4)', () => {
    const edition = toEdition(
      editionRow({ translationId: null, translation: null, textKind: 'ORIGINAL', lang: 'en' }),
    )

    expect(edition.lang).toBe('en')
    expect(edition.translator).toBeNull()
    expect(edition.textKind).toBe('ORIGINAL')
  })

  describe('тип тексту й мова — власні поля, а не висновок із перекладу чи твору', () => {
    it('невідомий текст: translationId = null НЕ робить видання оригіналом, мови немає', () => {
      const edition = toEdition(
        editionRow({ translationId: null, translation: null, textKind: 'UNKNOWN', lang: null }),
      )

      expect(edition).toMatchObject({ textKind: 'UNKNOWN', lang: null, translator: null })
    })

    it('мова видання не бере мови з твору, коли вона невідома', () => {
      const edition = toEdition(
        editionRow({ translationId: null, translation: null, textKind: 'UNKNOWN', lang: 'de' }),
      )

      expect(edition.lang).toBe('de')
    })

    it('твір без відомої мови оригіналу: оригінал зберігає введену мову видання', () => {
      const edition = toEdition(
        editionRow({ translationId: null, translation: null, textKind: 'ORIGINAL', lang: 'uk' }),
      )

      expect(edition).toMatchObject({ textKind: 'ORIGINAL', lang: 'uk' })
    })

    it('переклад без даних про перекладача: мова є, перекладача немає', () => {
      const edition = toEdition(
        editionRow({ translationId: null, translation: null, textKind: 'TRANSLATION', lang: 'uk' }),
      )

      expect(edition).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk', translator: null })
    })

    it('невідомий формат лишається невідомим', () => {
      expect(toEdition(editionRow({ format: null })).format).toBeNull()
    })
  })
})

describe('byEditionOrder', () => {
  const edition = (overrides: Partial<Edition>): Edition => ({
    ...toEdition(editionRow()),
    ...overrides,
  })

  it('новіше — вище', () => {
    const sorted = [edition({ id: 'a', year: 1985 }), edition({ id: 'b', year: 2021 })].sort(
      byEditionOrder,
    )

    expect(sorted.map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('без року — в кінець: невідомий рік не робить книжку найновішою', () => {
    const sorted = [
      edition({ id: 'a', year: null }),
      edition({ id: 'b', year: 1985 }),
      edition({ id: 'c', year: 2021 }),
    ].sort(byEditionOrder)

    expect(sorted.map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('за однакового року — за видавництвом, далі за id: порядок детермінований', () => {
    const sorted = [
      edition({ id: 'b', year: 2021, publisher: 'Астролябія' }),
      edition({ id: 'a', year: 2021, publisher: 'Веселка' }),
      edition({ id: 'c', year: 2021, publisher: 'Астролябія' }),
    ].sort(byEditionOrder)

    expect(sorted.map((item) => item.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('toViewerCapabilities', () => {
  const creatorId = 'creator-1'
  const strangerId = 'stranger-1'
  const ownerId = 'owner-1'

  it('creator: canEditWork true, and every own Edition/Translation is editable even with no Copy', () => {
    const capabilities = toViewerCapabilities(creatorId, {
      createdById: creatorId,
      editions: [{ id: 'e-1', createdById: creatorId, translationId: null, copies: [] }],
      translations: [{ id: 't-1', createdById: creatorId }],
    })

    expect(capabilities).toEqual({
      canEditWork: true,
      editableEditionIds: ['e-1'],
      editableTranslationIds: ['t-1'],
    })
  })

  it('stranger with no Copy anywhere: canEditWork false, nothing editable', () => {
    const capabilities = toViewerCapabilities(strangerId, {
      createdById: creatorId,
      editions: [{ id: 'e-1', createdById: creatorId, translationId: 't-1', copies: [] }],
      translations: [{ id: 't-1', createdById: creatorId }],
    })

    expect(capabilities).toEqual({
      canEditWork: false,
      editableEditionIds: [],
      editableTranslationIds: [],
    })
  })

  it('R8: owning a Copy of one Edition grants Work-level and that Edition/Translation-level rights, not other Editions', () => {
    const capabilities = toViewerCapabilities(ownerId, {
      createdById: creatorId,
      editions: [
        {
          id: 'e-owned',
          createdById: creatorId,
          translationId: 't-owned',
          copies: [{ id: 'c-1' }],
        },
        { id: 'e-other', createdById: creatorId, translationId: 't-other', copies: [] },
      ],
      translations: [
        { id: 't-owned', createdById: creatorId },
        { id: 't-other', createdById: creatorId },
      ],
    })

    expect(capabilities).toEqual({
      canEditWork: true,
      editableEditionIds: ['e-owned'],
      editableTranslationIds: ['t-owned'],
    })
  })

  it('a Translation is editable via ANY Edition referencing it, not just the first', () => {
    const capabilities = toViewerCapabilities(ownerId, {
      createdById: creatorId,
      editions: [
        { id: 'e-1', createdById: creatorId, translationId: 'shared-t', copies: [] },
        { id: 'e-2', createdById: creatorId, translationId: 'shared-t', copies: [{ id: 'c-1' }] },
      ],
      translations: [{ id: 'shared-t', createdById: creatorId }],
    })

    expect(capabilities.editableTranslationIds).toEqual(['shared-t'])
  })
})

describe('CatalogRevision snapshots (Stage 8e-2, R9)', () => {
  it('toWorkRevisionSnapshot captures full editable metadata, authors by position with nameLatin', () => {
    const snapshot = toWorkRevisionSnapshot({
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      description: null,
      authors: [
        {
          role: 'AUTHOR',
          position: 0,
          author: { id: 'a-1', name: 'Ґреґорі Робертс', nameLatin: 'Gregory Roberts' },
        },
      ],
    })

    expect(snapshot).toEqual({
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      description: null,
      authors: [
        {
          authorId: 'a-1',
          name: 'Ґреґорі Робертс',
          nameLatin: 'Gregory Roberts',
          role: 'AUTHOR',
          position: 0,
        },
      ],
    })
  })

  it('toTranslationRevisionSnapshot picks exactly the editable Translation fields', () => {
    expect(
      toTranslationRevisionSnapshot({
        translator: 'Хтось',
        lang: 'uk',
        sourceLang: 'en',
        year: 1985,
        isAbridged: false,
        hasNotes: true,
        notes: 'нотатка',
      }),
    ).toEqual({
      translator: 'Хтось',
      lang: 'uk',
      sourceLang: 'en',
      year: 1985,
      isAbridged: false,
      hasNotes: true,
      notes: 'нотатка',
    })
  })

  it('toEditionRevisionSnapshot picks exactly the editable Edition fields', () => {
    expect(
      toEditionRevisionSnapshot({
        publisher: 'КСД',
        year: 2019,
        isbn13: '9783161484100',
        pageCount: 320,
        coverUrl: null,
        format: 'PAPERBACK',
        translationId: null,
        textKind: 'ORIGINAL',
        lang: 'en',
      }),
    ).toEqual({
      publisher: 'КСД',
      year: 2019,
      isbn13: '9783161484100',
      pageCount: 320,
      coverUrl: null,
      format: 'PAPERBACK',
      translationId: null,
      textKind: 'ORIGINAL',
      lang: 'en',
    })
  })
})

describe('escapeLikePattern', () => {
  it('знешкоджує символи LIKE — інакше «100%» шукало б усе підряд', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
  })

  it('не чіпає звичайний текст', () => {
    expect(escapeLikePattern('шантарам')).toBe('шантарам')
  })
})
