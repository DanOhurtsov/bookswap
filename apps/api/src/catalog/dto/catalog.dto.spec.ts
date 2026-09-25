// `@Type()` на вкладеному масиві авторів читає метадані ще на етапі декорування,
// тож поліфіл потрібен до імпорту DTO. У застосунку його підключає сам Nest.
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  catalogSearchRequestSchema,
  createEditionRequestSchema,
  createTranslationRequestSchema,
  createWorkRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import {
  CatalogSearchDto,
  CreateEditionDto,
  CreateTranslationDto,
  CreateWorkDto,
} from './catalog.dto'

/**
 * Той самий тест парності, що й для DTO акаунта та дружби: §11 вимагає обидва
 * механізми валідації, а платою за це є ризик, що два описи однієї структури
 * розійдуться. Тут він ловиться, а не на проді.
 *
 * Для каталогу ставка вища за звичайну: контрольну суму ISBN і перелік кодів
 * ISO 639-1 неможливо «майже однаково» повторити двічі, тому декоратори
 * `IsIsbn13` / `IsLanguageCode` побудовані поверх тих самих предикатів зі
 * `shared`. Цей тест доводить, що вирок справді збігається.
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

const work = { title: 'Шантарам', origLang: 'en', authors: [{ name: 'Ґреґорі Робертс' }] }

describe('CreateWorkDto ↔ createWorkRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CreateWorkDto, createWorkRequestSchema, [
      { name: 'мінімальний твір', payload: work, valid: true },
      {
        name: 'наявний автор за id',
        payload: { ...work, authors: [{ authorId: 'a-1' }] },
        valid: true,
      },
      {
        name: 'автор із роллю',
        payload: { ...work, authors: [{ name: 'Хтось', role: 'EDITOR' }] },
        valid: true,
      },
      {
        name: 'невідома роль',
        payload: { ...work, authors: [{ name: 'Хтось', role: 'TYPESETTER' }] },
        valid: false,
      },
      {
        name: 'і id, і імʼя',
        payload: { ...work, authors: [{ authorId: 'a-1', name: 'Хтось' }] },
        valid: false,
      },
      {
        name: 'ні id, ні імені',
        payload: { ...work, authors: [{ role: 'AUTHOR' }] },
        valid: false,
      },
      { name: 'без авторів', payload: { ...work, authors: [] }, valid: false },
      { name: 'порожня назва', payload: { ...work, title: '   ' }, valid: false },
      { name: 'назва на межі', payload: { ...work, title: 'я'.repeat(300) }, valid: true },
      { name: 'назва на символ довша', payload: { ...work, title: 'я'.repeat(301) }, valid: false },
      { name: 'невідома мова', payload: { ...work, origLang: 'zz' }, valid: false },
      { name: 'мова у верхньому регістрі', payload: { ...work, origLang: 'EN' }, valid: true },
      { name: 'трибуквений код мови', payload: { ...work, origLang: 'ukr' }, valid: false },
      { name: 'рік до нашої ери', payload: { ...work, firstPubYear: -750 }, valid: true },
      { name: 'рік поза межами', payload: { ...work, firstPubYear: 2500 }, valid: false },
      { name: 'дробовий рік', payload: { ...work, firstPubYear: 2003.5 }, valid: false },
    ])
  })

  it('обидва механізми нормалізують мову однаково', () => {
    expect(plainToInstance(CreateWorkDto, { ...work, origLang: ' EN ' }).origLang).toBe('en')
    expect(createWorkRequestSchema.parse({ ...work, origLang: ' EN ' }).origLang).toBe('en')
  })

  /**
   * `createWorkRequestSchema` itself still strips unknown top-level fields
   * rather than rejecting them (unlike its Stage 8e-1 PATCH counterpart,
   * `workPatchRequestSchema` — see `catalog-correction.ts`, deliberately kept
   * separate so this create contract's behavior doesn't change silently). The
   * DTO's own `forbidNonWhitelisted` still refuses the request either way, so
   * this only documents where the two mechanisms diverge for CREATE, not a
   * gap either one has.
   */
  it('невідомі поля: zod зрізає, DTO відхиляє — до Prisma вони не доїжджають ніяк', () => {
    expect(createWorkRequestSchema.parse({ ...work, ratingAvg: 5 })).not.toHaveProperty('ratingAvg')
    expect(acceptedByDto(CreateWorkDto, { ...work, ratingAvg: 5 })).toBe(false)
  })

  /**
   * Stage 8e-1: `authorId`/`name`/`role` are optional but NOT nullable in
   * `workAuthorInputSchema` — `nameLatin` is the one nullable exception. The
   * DTO used to accept `null` here regardless (`@IsOptional()` treats `null`
   * the same as "omitted"), which was a real gap against CREATE's own already-
   * agreed zod contract, not a new rule — see `WorkAuthorInputDto`
   * (`IsOptionalNotNull`, `common/validators.ts`).
   */
  it('автор: authorId/name/role — null там, де zod його забороняє, DTO теж відхиляє', () => {
    expectAgreement(CreateWorkDto, createWorkRequestSchema, [
      {
        name: 'authorId null',
        payload: { ...work, authors: [{ authorId: null, name: 'X' }] },
        valid: false,
      },
      {
        name: 'name null (з authorId)',
        payload: { ...work, authors: [{ authorId: 'a-1', name: null }] },
        valid: false,
      },
      {
        name: 'role null',
        payload: { ...work, authors: [{ name: 'X', role: null }] },
        valid: false,
      },
      {
        name: 'nameLatin null — дозволено, це «прибрати транслітерацію»',
        payload: { ...work, authors: [{ name: 'X', nameLatin: null }] },
        valid: true,
      },
    ])
  })
})

describe('CreateTranslationDto ↔ createTranslationRequestSchema', () => {
  const translation = { translator: 'Олександр Мокровольський', lang: 'uk', sourceLang: 'en' }

  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CreateTranslationDto, createTranslationRequestSchema, [
      { name: 'мінімальний переклад', payload: translation, valid: true },
      {
        name: 'з ознаками §10.3',
        payload: { ...translation, isAbridged: true, hasNotes: true, year: 1985 },
        valid: true,
      },
      { name: 'без перекладача', payload: { lang: 'uk', sourceLang: 'en' }, valid: false },
      { name: 'порожній перекладач', payload: { ...translation, translator: '  ' }, valid: false },
      { name: 'невідома мова перекладу', payload: { ...translation, lang: 'zz' }, valid: false },
      {
        name: 'невідома мова джерела',
        payload: { ...translation, sourceLang: 'zz' },
        valid: false,
      },
      { name: 'isAbridged рядком', payload: { ...translation, isAbridged: 'так' }, valid: false },
    ])
  })
})

describe('CreateEditionDto ↔ createEditionRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CreateEditionDto, createEditionRequestSchema, [
      { name: 'порожнє тіло', payload: {}, valid: true },
      { name: 'видання мовою оригіналу', payload: { translationId: null }, valid: true },
      { name: 'коректний ISBN', payload: { isbn13: '9783161484100' }, valid: true },
      { name: 'ISBN із дефісами', payload: { isbn13: '978-3-16-148410-0' }, valid: true },
      { name: 'ISBN із поламаною сумою', payload: { isbn13: '9783161484101' }, valid: false },
      { name: 'EAN поза Bookland', payload: { isbn13: '4820000000000' }, valid: false },
      { name: 'ISBN-10', payload: { isbn13: '0306406152' }, valid: false },
      { name: 'ISBN прибрано явним null', payload: { isbn13: null }, valid: true },
      { name: 'нуль сторінок', payload: { pageCount: 0 }, valid: false },
      { name: 'обкладинка не URL', payload: { coverUrl: 'не посилання' }, valid: false },
      { name: 'невідомий формат', payload: { format: 'SCROLL' }, valid: false },
      { name: 'відомий формат', payload: { format: 'POCKET' }, valid: true },
    ])
  })

  it('обидва механізми знімають дефіси з ISBN', () => {
    expect(plainToInstance(CreateEditionDto, { isbn13: '978-3-16-148410-0' }).isbn13).toBe(
      '9783161484100',
    )
    expect(createEditionRequestSchema.parse({ isbn13: '978-3-16-148410-0' }).isbn13).toBe(
      '9783161484100',
    )
  })
})

describe('CatalogSearchDto ↔ catalogSearchRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CatalogSearchDto, catalogSearchRequestSchema, [
      { name: 'звичайний запит', payload: { q: 'шантарам' }, valid: true },
      { name: 'два символи', payload: { q: 'шa' }, valid: true },
      { name: 'один символ', payload: { q: 'ш' }, valid: false },
      { name: 'самі пробіли', payload: { q: '   ' }, valid: false },
      { name: 'без параметра', payload: {}, valid: false },
      { name: 'сторінка як рядок', payload: { q: 'шан', page: '3' }, valid: true },
      { name: 'нульова сторінка', payload: { q: 'шан', page: '0' }, valid: false },
      { name: 'сторінка глибше 20', payload: { q: 'шан', page: '21' }, valid: false },
      { name: 'pageSize 10', payload: { q: 'шан', pageSize: '10' }, valid: true },
      { name: 'pageSize 20', payload: { q: 'шан', pageSize: '20' }, valid: true },
      { name: 'pageSize 50', payload: { q: 'шан', pageSize: '50' }, valid: true },
      { name: 'pageSize 15', payload: { q: 'шан', pageSize: '15' }, valid: false },
      { name: 'pageSize 100', payload: { q: 'шан', pageSize: '100' }, valid: false },
      { name: 'pageSize не число', payload: { q: 'шан', pageSize: 'abc' }, valid: false },
    ])
  })
})
