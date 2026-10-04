import { CATALOG_ENTITY_TYPE } from '../domain/catalog'
import {
  catalogRevisionSnapshotSchemas,
  editionPatchRequestSchema,
  editionPatchResponseSchema,
  editionRevisionSnapshotSchema,
  expectedRevisionSchema,
  translationPatchRequestSchema,
  translationPatchResponseSchema,
  translationRevisionSnapshotSchema,
  workPatchRequestSchema,
  workPatchResponseSchema,
  workRevisionSnapshotSchema,
} from './catalog-correction'

/**
 * Stage 8e-1 (docs/plan/stage-8-inventory.md, R9/R10/R10a): direct tests of the
 * PATCH request/response schemas and the `CatalogRevision.before`/`after`
 * snapshot schemas — separate from `catalog-correction.dto.spec.ts`, which only
 * checks that the Nest DTOs agree with these schemas, not that the schemas
 * themselves encode the agreed 8e-1 rules.
 */
describe('expectedRevisionSchema', () => {
  it('positive integers only — revision starts at 1 and only increments', () => {
    expect(expectedRevisionSchema.safeParse(1).success).toBe(true)
    expect(expectedRevisionSchema.safeParse(0).success).toBe(false)
    expect(expectedRevisionSchema.safeParse(-1).success).toBe(false)
    expect(expectedRevisionSchema.safeParse(1.5).success).toBe(false)
  })
})

describe('workPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('an empty patch (just expectedRevision) is valid — omitted fields mean unchanged', () => {
    expect(workPatchRequestSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an unknown top-level field instead of silently stripping it', () => {
    expect(workPatchRequestSchema.safeParse({ ...base, workId: 'w-1' }).success).toBe(false)
  })

  it('title: optional but not nullable; origLang: nullable — null означає «мова оригіналу невідома»', () => {
    expect(workPatchRequestSchema.safeParse({ ...base, title: 'Нова назва' }).success).toBe(true)
    expect(workPatchRequestSchema.safeParse({ ...base, title: null }).success).toBe(false)
    expect(workPatchRequestSchema.safeParse({ ...base, origLang: 'uk' }).success).toBe(true)
    expect(workPatchRequestSchema.safeParse({ ...base, origLang: null }).success).toBe(true)
    expect(workPatchRequestSchema.safeParse({ ...base, origLang: 'zz' }).success).toBe(false)
  })

  it('firstPubYear/description: optional AND nullable — null clears the value', () => {
    expect(workPatchRequestSchema.safeParse({ ...base, firstPubYear: null }).success).toBe(true)
    expect(workPatchRequestSchema.safeParse({ ...base, description: null }).success).toBe(true)
  })

  describe('authors (R10a)', () => {
    it('omitted — unchanged; null and [] are forbidden; a valid array replaces the list', () => {
      expect(workPatchRequestSchema.safeParse(base).success).toBe(true)
      expect(workPatchRequestSchema.safeParse({ ...base, authors: null }).success).toBe(false)
      expect(workPatchRequestSchema.safeParse({ ...base, authors: [] }).success).toBe(false)
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ name: 'Хтось' }] }).success,
      ).toBe(true)
    })

    it('does not accept a client-supplied position — R10a reserves it for the server', () => {
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ name: 'Хтось', position: 0 }],
        }).success,
      ).toBe(false)
    })

    it('rejects any other unknown key on an author element too', () => {
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ name: 'Хтось', extra: 'field' }],
        }).success,
      ).toBe(false)
    })

    it('authorId/role: optional but not nullable, same as name', () => {
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ authorId: null, name: 'X' }] })
          .success,
      ).toBe(false)
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ name: 'X', role: null }] }).success,
      ).toBe(false)
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ authorId: 'a1', name: null }] })
          .success,
      ).toBe(false)
    })

    it('nameLatin: optional AND nullable — null clears the transliteration', () => {
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ name: 'Хтось', nameLatin: null }],
        }).success,
      ).toBe(true)
    })

    it('still requires exactly one of authorId / name per element', () => {
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ authorId: 'a-1', name: 'Хтось' }],
        }).success,
      ).toBe(false)
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ role: 'AUTHOR' }] }).success,
      ).toBe(false)
    })

    /**
     * PO decision (Stage 8e-2, R10a — replaces the choice 8e-1 left open):
     * `authorId` + `nameLatin` together is REJECTED, even when `nameLatin` is
     * explicitly `null`. `nameLatin` alone (with a new `name`, no `authorId`)
     * stays valid — see the "nameLatin: optional AND nullable" test above.
     */
    it('rejects authorId + nameLatin together — even nameLatin: null', () => {
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ authorId: 'a-1', nameLatin: 'Htos' }],
        }).success,
      ).toBe(false)
      expect(
        workPatchRequestSchema.safeParse({
          ...base,
          authors: [{ authorId: 'a-1', nameLatin: null }],
        }).success,
      ).toBe(false)
      // authorId alone (no nameLatin key at all) is unaffected.
      expect(
        workPatchRequestSchema.safeParse({ ...base, authors: [{ authorId: 'a-1' }] }).success,
      ).toBe(true)
    })
  })
})

describe('translationPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('an empty patch is valid', () => {
    expect(translationPatchRequestSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an unknown top-level field', () => {
    expect(translationPatchRequestSchema.safeParse({ ...base, translationId: 't-1' }).success).toBe(
      false,
    )
  })

  it('translator/lang/sourceLang/isAbridged/hasNotes: optional but not nullable', () => {
    expect(translationPatchRequestSchema.safeParse({ ...base, translator: null }).success).toBe(
      false,
    )
    expect(translationPatchRequestSchema.safeParse({ ...base, lang: null }).success).toBe(false)
    expect(translationPatchRequestSchema.safeParse({ ...base, sourceLang: null }).success).toBe(
      false,
    )
    expect(translationPatchRequestSchema.safeParse({ ...base, isAbridged: null }).success).toBe(
      false,
    )
    expect(translationPatchRequestSchema.safeParse({ ...base, hasNotes: null }).success).toBe(false)
  })

  it('year/notes: optional AND nullable', () => {
    expect(translationPatchRequestSchema.safeParse({ ...base, year: null }).success).toBe(true)
    expect(translationPatchRequestSchema.safeParse({ ...base, notes: null }).success).toBe(true)
  })
})

describe('editionPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('an empty patch is valid', () => {
    expect(editionPatchRequestSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an unknown top-level field', () => {
    expect(editionPatchRequestSchema.safeParse({ ...base, workId: 'w-1' }).success).toBe(false)
  })

  it('format: nullable — null означає «формат невідомий»', () => {
    expect(editionPatchRequestSchema.safeParse({ ...base, format: 'POCKET' }).success).toBe(true)
    expect(editionPatchRequestSchema.safeParse({ ...base, format: null }).success).toBe(true)
    expect(editionPatchRequestSchema.safeParse({ ...base, format: 'GLOSSY' }).success).toBe(false)
  })

  it('textKind: лише відомі значення й не nullable; lang: код мови або null (невідома)', () => {
    for (const textKind of ['ORIGINAL', 'TRANSLATION', 'UNKNOWN']) {
      expect(editionPatchRequestSchema.safeParse({ ...base, textKind }).success).toBe(true)
    }

    expect(editionPatchRequestSchema.safeParse({ ...base, textKind: 'OTHER' }).success).toBe(false)
    expect(editionPatchRequestSchema.safeParse({ ...base, textKind: null }).success).toBe(false)
    expect(editionPatchRequestSchema.safeParse({ ...base, lang: 'uk' }).success).toBe(true)
    expect(editionPatchRequestSchema.safeParse({ ...base, lang: null }).success).toBe(true)
    expect(editionPatchRequestSchema.safeParse({ ...base, lang: 'zz' }).success).toBe(false)
  })

  it('translationId/publisher/year/isbn13/pageCount/coverUrl: optional AND nullable', () => {
    for (const field of ['translationId', 'publisher', 'year', 'isbn13', 'pageCount', 'coverUrl']) {
      expect(editionPatchRequestSchema.safeParse({ ...base, [field]: null }).success).toBe(true)
    }
  })
})

describe('PATCH response schemas', () => {
  it('workPatchResponseSchema — Work plus its ordered, positioned authors', () => {
    const parsed = workPatchResponseSchema.safeParse({
      work: {
        id: 'w-1',
        title: 'Шантарам',
        origLang: 'en',
        firstPubYear: 2003,
        description: null,
        createdAt: new Date().toISOString(),
        revision: 2,
      },
      authors: [
        {
          id: 'a-1',
          name: 'Ґреґорі Девід Робертс',
          nameLatin: 'Gregory David Roberts',
          role: 'AUTHOR',
          position: 0,
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it('translationPatchResponseSchema/editionPatchResponseSchema are the same shape as create', () => {
    expect(
      translationPatchResponseSchema.safeParse({
        translation: {
          id: 't-1',
          workId: 'w-1',
          translator: 'Хтось',
          textKind: 'ORIGINAL',
          lang: 'uk',
          sourceLang: 'en',
          year: null,
          isAbridged: false,
          hasNotes: false,
          notes: null,
          editionCount: 0,
          revision: 2,
        },
      }).success,
    ).toBe(true)

    expect(
      editionPatchResponseSchema.safeParse({
        edition: {
          id: 'e-1',
          workId: 'w-1',
          translationId: null,
          publisher: null,
          year: null,
          isbn13: null,
          pageCount: null,
          coverUrl: null,
          format: 'PAPERBACK',
          textKind: 'ORIGINAL',
          lang: 'en',
          translator: null,
          revision: 2,
        },
      }).success,
    ).toBe(true)
  })
})

describe('CatalogRevision.before/after snapshot schemas', () => {
  it('workRevisionSnapshotSchema captures the full editable metadata, nameLatin included', () => {
    const snapshot = {
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      description: null,
      authors: [
        {
          authorId: 'a-1',
          name: 'Ґреґорі Девід Робертс',
          nameLatin: 'Gregory David Roberts',
          role: 'AUTHOR',
          position: 0,
        },
      ],
    }

    expect(workRevisionSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('workRevisionSnapshotSchema author entries require nameLatin (even as null) — author input allows it', () => {
    const { authors: _authors, ...rest } = {
      title: 'T',
      origLang: 'en',
      firstPubYear: null,
      description: null,
      authors: [{ authorId: 'a-1', name: 'X', role: 'AUTHOR', position: 0 }],
    }
    const withoutNameLatin = {
      ...rest,
      authors: [{ authorId: 'a-1', name: 'X', role: 'AUTHOR', position: 0 }],
    }

    // Field omitted entirely — must fail, since nameLatin has no default and
    // is part of what a correction can edit (R10).
    expect(workRevisionSnapshotSchema.safeParse(withoutNameLatin).success).toBe(false)

    const withNullNameLatin = {
      ...rest,
      authors: [{ authorId: 'a-1', name: 'X', nameLatin: null, role: 'AUTHOR', position: 0 }],
    }

    expect(workRevisionSnapshotSchema.safeParse(withNullNameLatin).success).toBe(true)
  })

  it('translationRevisionSnapshotSchema captures every editable Translation field', () => {
    const snapshot = {
      translator: 'Хтось',
      textKind: 'ORIGINAL',
      lang: 'uk',
      sourceLang: 'en',
      year: 1985,
      isAbridged: false,
      hasNotes: true,
      notes: 'нотатка',
    }

    expect(translationRevisionSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('editionRevisionSnapshotSchema captures every editable Edition field', () => {
    const snapshot = {
      publisher: 'КСД',
      year: 2019,
      isbn13: '9783161484100',
      pageCount: 320,
      coverUrl: 'https://example.com/cover.jpg',
      format: 'PAPERBACK',
      translationId: null,
    }

    expect(editionRevisionSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('catalogRevisionSnapshotSchemas has exactly one entry per CatalogEntityType', () => {
    expect(Object.keys(catalogRevisionSnapshotSchemas).sort()).toEqual(
      [...CATALOG_ENTITY_TYPE].sort(),
    )
  })

  /**
   * Structural completeness check: every field a PATCH can change must also
   * appear in the snapshot schema for that entity, so `CatalogRevision.before`/
   * `after` can never silently drop a field the write path actually edited.
   * `authors` is Work's one exception — the patch takes an input shape
   * (`authorId`/`name`), the snapshot a resolved one (`authorId`/`name`/
   * `nameLatin`/`role`/`position`); it is asserted separately above.
   */
  it('every patchable field has a matching snapshot field (Work, Translation, Edition)', () => {
    const patchFields = (schema: { shape: Record<string, unknown> }, omit: string[]): string[] =>
      Object.keys(schema.shape).filter((field) => !omit.includes(field))

    expect(patchFields(workPatchRequestSchema, ['expectedRevision', 'authors']).sort()).toEqual(
      Object.keys(workRevisionSnapshotSchema.shape)
        .filter((field) => field !== 'authors')
        .sort(),
    )

    expect(patchFields(translationPatchRequestSchema, ['expectedRevision']).sort()).toEqual(
      Object.keys(translationRevisionSnapshotSchema.shape).sort(),
    )

    expect(patchFields(editionPatchRequestSchema, ['expectedRevision']).sort()).toEqual(
      Object.keys(editionRevisionSnapshotSchema.shape).sort(),
    )
  })
})
