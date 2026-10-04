import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  editionPatchRequestSchema,
  translationPatchRequestSchema,
  workPatchRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import { PatchEditionDto, PatchTranslationDto, PatchWorkDto } from './catalog-correction.dto'

/**
 * Той самий парність-тест, що й `catalog.dto.spec.ts`, для PATCH-контрактів
 * Stage 8e-1 (docs/plan/stage-8-inventory.md, R9/R10/R10a).
 *
 * Головний ризик тут інший, ніж у create-DTO: `@IsOptional()` у class-validator
 * трактує і `undefined`, і `null` як «пропущено», а zod `.partial()` додає
 * лише `| undefined`. Без `IsOptionalNotNull` (`common/validators.ts`) DTO
 * мовчки пропустив би `title: null` там, де схема його відхиляє, — саме це
 * тут і перевіряється явними `null`-кейсами на КОЖНОМУ не-nullable полі.
 */
type Constructor<T> = new () => T

function acceptedByDto<T extends object>(Dto: Constructor<T>, payload: unknown): boolean {
  const instance = plainToInstance(Dto, payload)

  return (
    validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true }).length === 0
  )
}

function expectAgreement<T extends object>(
  Dto: Constructor<T>,
  schema: ZodType,
  cases: { name: string; payload: unknown; valid: boolean }[],
): void {
  for (const { name, payload, valid } of cases) {
    const byZod = schema.safeParse(payload).success
    const byDto = acceptedByDto(Dto, payload)

    expect({ name, byZod, byDto }).toEqual({ name, byZod: valid, byDto: valid })
  }
}

describe('PatchWorkDto ↔ workPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('omitted — без змін: порожній патч (лише expectedRevision) валідний', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'лише expectedRevision', payload: base, valid: true },
    ])
  })

  it('expectedRevision: обов’язкове додатне ціле', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'без expectedRevision', payload: {}, valid: false },
      { name: 'expectedRevision = 0', payload: { expectedRevision: 0 }, valid: false },
      { name: 'expectedRevision від’ємне', payload: { expectedRevision: -1 }, valid: false },
      { name: 'expectedRevision дробове', payload: { expectedRevision: 1.5 }, valid: false },
      { name: 'expectedRevision на межі', payload: { expectedRevision: 1 }, valid: true },
    ])
  })

  it('title: опційний, але null заборонений; origLang: null — «мова оригіналу невідома»', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'title валідний', payload: { ...base, title: 'Нова назва' }, valid: true },
      { name: 'title null', payload: { ...base, title: null }, valid: false },
      { name: 'title порожній', payload: { ...base, title: '   ' }, valid: false },
      { name: 'origLang валідний', payload: { ...base, origLang: 'uk' }, valid: true },
      { name: 'origLang null', payload: { ...base, origLang: null }, valid: true },
      { name: 'origLang невідомий', payload: { ...base, origLang: 'zz' }, valid: false },
    ])
  })

  it('firstPubYear/description: опційні І nullable — null дозволений (прибрати значення)', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'firstPubYear null', payload: { ...base, firstPubYear: null }, valid: true },
      { name: 'firstPubYear валідний', payload: { ...base, firstPubYear: 2003 }, valid: true },
      { name: 'firstPubYear поза межами', payload: { ...base, firstPubYear: 5000 }, valid: false },
      { name: 'description null', payload: { ...base, description: null }, valid: true },
      { name: 'description валідний', payload: { ...base, description: 'опис' }, valid: true },
    ])
  })

  it('authors: omitted — без змін; null і [] заборонені; переданий — повна заміна', () => {
    const author = { name: 'Хтось' }

    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'authors omitted', payload: base, valid: true },
      { name: 'authors null', payload: { ...base, authors: null }, valid: false },
      { name: 'authors []', payload: { ...base, authors: [] }, valid: false },
      { name: 'authors валідний масив', payload: { ...base, authors: [author] }, valid: true },
      {
        name: 'authors: і id, і name',
        payload: { ...base, authors: [{ authorId: 'a-1', name: 'Хтось' }] },
        valid: false,
      },
      {
        name: 'authors: невідома роль',
        payload: { ...base, authors: [{ name: 'Хтось', role: 'TYPESETTER' }] },
        valid: false,
      },
      {
        name: 'authors: більше за стелю',
        payload: {
          ...base,
          authors: Array.from({ length: 11 }, (_, index) => ({ name: `Автор ${String(index)}` })),
        },
        valid: false,
      },
    ])
  })

  it('невідоме поле верхнього рівня: обидва відхиляють — на відміну від CREATE, тут це не розбіжність', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      { name: 'невідоме поле workId', payload: { ...base, workId: 'x' }, valid: false },
    ])
  })

  it('authors: вкладений елемент — невідоме поле (зокрема position) відхиляють обидва', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      {
        name: 'клієнтський position',
        payload: { ...base, authors: [{ name: 'Хтось', position: 0 }] },
        valid: false,
      },
      {
        name: 'будь-яке інше невідоме поле елемента',
        payload: { ...base, authors: [{ name: 'Хтось', extra: 'x' }] },
        valid: false,
      },
    ])
  })

  it('authors: authorId/name/role — null там, де zod його забороняє, DTO теж відхиляє', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      {
        name: 'authorId null',
        payload: { ...base, authors: [{ authorId: null, name: 'X' }] },
        valid: false,
      },
      {
        name: 'name null (з authorId)',
        payload: { ...base, authors: [{ authorId: 'a-1', name: null }] },
        valid: false,
      },
      {
        name: 'role null',
        payload: { ...base, authors: [{ name: 'X', role: null }] },
        valid: false,
      },
      {
        name: 'nameLatin null — дозволено',
        payload: { ...base, authors: [{ name: 'X', nameLatin: null }] },
        valid: true,
      },
    ])
  })

  /**
   * PO decision (Stage 8e-2, R10a): `authorId` + `nameLatin` together is
   * rejected by both sides — even when `nameLatin` is explicitly `null`.
   */
  it('authors: authorId + nameLatin разом — 400 на обох сторонах, навіть nameLatin: null', () => {
    expectAgreement(PatchWorkDto, workPatchRequestSchema, [
      {
        name: 'authorId + nameLatin (рядок)',
        payload: { ...base, authors: [{ authorId: 'a-1', nameLatin: 'Htos' }] },
        valid: false,
      },
      {
        name: 'authorId + nameLatin: null',
        payload: { ...base, authors: [{ authorId: 'a-1', nameLatin: null }] },
        valid: false,
      },
      {
        name: 'authorId сам собою — не порушує правило',
        payload: { ...base, authors: [{ authorId: 'a-1' }] },
        valid: true,
      },
    ])
  })
})

describe('PatchTranslationDto ↔ translationPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('omitted — без змін', () => {
    expectAgreement(PatchTranslationDto, translationPatchRequestSchema, [
      { name: 'лише expectedRevision', payload: base, valid: true },
    ])
  })

  it('translator/lang/sourceLang: опційні, null заборонений', () => {
    expectAgreement(PatchTranslationDto, translationPatchRequestSchema, [
      { name: 'translator валідний', payload: { ...base, translator: 'Хтось' }, valid: true },
      { name: 'translator null', payload: { ...base, translator: null }, valid: false },
      { name: 'translator порожній', payload: { ...base, translator: '  ' }, valid: false },
      { name: 'lang null', payload: { ...base, lang: null }, valid: false },
      { name: 'lang невідома', payload: { ...base, lang: 'zz' }, valid: false },
      { name: 'sourceLang null', payload: { ...base, sourceLang: null }, valid: false },
    ])
  })

  it('isAbridged/hasNotes: опційні булеві, null заборонений', () => {
    expectAgreement(PatchTranslationDto, translationPatchRequestSchema, [
      { name: 'isAbridged true', payload: { ...base, isAbridged: true }, valid: true },
      { name: 'isAbridged null', payload: { ...base, isAbridged: null }, valid: false },
      { name: 'isAbridged рядком', payload: { ...base, isAbridged: 'так' }, valid: false },
      { name: 'hasNotes null', payload: { ...base, hasNotes: null }, valid: false },
    ])
  })

  it('year/notes: опційні І nullable', () => {
    expectAgreement(PatchTranslationDto, translationPatchRequestSchema, [
      { name: 'year null', payload: { ...base, year: null }, valid: true },
      { name: 'year валідний', payload: { ...base, year: 1985 }, valid: true },
      { name: 'notes null', payload: { ...base, notes: null }, valid: true },
    ])
  })

  it('невідоме поле верхнього рівня: обидва відхиляють', () => {
    expectAgreement(PatchTranslationDto, translationPatchRequestSchema, [
      {
        name: 'невідоме поле translationId',
        payload: { ...base, translationId: 't-1' },
        valid: false,
      },
    ])
  })
})

describe('PatchEditionDto ↔ editionPatchRequestSchema', () => {
  const base = { expectedRevision: 1 }

  it('omitted — без змін', () => {
    expectAgreement(PatchEditionDto, editionPatchRequestSchema, [
      { name: 'лише expectedRevision', payload: base, valid: true },
    ])
  })

  it('поля видання лишаються nullable-опційними — null прибирає значення', () => {
    expectAgreement(PatchEditionDto, editionPatchRequestSchema, [
      { name: 'translationId null', payload: { ...base, translationId: null }, valid: true },
      { name: 'publisher null', payload: { ...base, publisher: null }, valid: true },
      { name: 'year null', payload: { ...base, year: null }, valid: true },
      { name: 'isbn13 null', payload: { ...base, isbn13: null }, valid: true },
      { name: 'isbn13 валідний', payload: { ...base, isbn13: '9783161484100' }, valid: true },
      { name: 'isbn13 поламана сума', payload: { ...base, isbn13: '9783161484101' }, valid: false },
      { name: 'pageCount null', payload: { ...base, pageCount: null }, valid: true },
      { name: 'pageCount нуль', payload: { ...base, pageCount: 0 }, valid: false },
      { name: 'coverUrl null', payload: { ...base, coverUrl: null }, valid: true },
      { name: 'coverUrl не URL', payload: { ...base, coverUrl: 'не посилання' }, valid: false },
    ])
  })

  it('format: опційний і nullable — null означає «формат невідомий»', () => {
    expectAgreement(PatchEditionDto, editionPatchRequestSchema, [
      { name: 'format валідний', payload: { ...base, format: 'POCKET' }, valid: true },
      { name: 'format null', payload: { ...base, format: null }, valid: true },
      { name: 'format невідомий', payload: { ...base, format: 'SCROLL' }, valid: false },
    ])
  })

  it('textKind: лише відомі значення, не nullable; lang: код мови або null', () => {
    expectAgreement(PatchEditionDto, editionPatchRequestSchema, [
      { name: 'textKind ORIGINAL', payload: { ...base, textKind: 'ORIGINAL' }, valid: true },
      { name: 'textKind UNKNOWN', payload: { ...base, textKind: 'UNKNOWN' }, valid: true },
      { name: 'textKind невідомий', payload: { ...base, textKind: 'OTHER' }, valid: false },
      { name: 'textKind null', payload: { ...base, textKind: null }, valid: false },
      { name: 'lang валідна', payload: { ...base, lang: 'uk' }, valid: true },
      {
        name: 'lang верхній регістр нормалізується',
        payload: { ...base, lang: 'UK' },
        valid: true,
      },
      { name: 'lang null', payload: { ...base, lang: null }, valid: true },
      { name: 'lang невідома', payload: { ...base, lang: 'zz' }, valid: false },
    ])
  })

  it('невідоме поле верхнього рівня: обидва відхиляють', () => {
    expectAgreement(PatchEditionDto, editionPatchRequestSchema, [
      { name: 'невідоме поле workId', payload: { ...base, workId: 'w-1' }, valid: false },
    ])
  })
})
