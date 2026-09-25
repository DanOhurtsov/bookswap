import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  catalogDiscoveryRequestSchema,
  discoveryScopeViolation,
  workHoldersRequestSchema,
} from '@bookswap/shared'
import { CatalogDiscoveryDto, WorkHoldersQueryDto } from './catalog.dto'

/** Паритет DTO ↔ zod для нових параметрів Етапу 9 + правило scope (варіант A). */
function dtoAccepts(Dto: new () => object, payload: unknown): boolean {
  const instance = plainToInstance(Dto, payload)

  return validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }).length === 0
}

describe('CatalogDiscoveryDto ↔ catalogDiscoveryRequestSchema', () => {
  it.each([
    { name: 'порожній запит — перегляд', payload: {}, valid: true },
    { name: 'порожній q — перегляд', payload: { q: '' }, valid: true },
    { name: 'q із пробілів — перегляд', payload: { q: '   ' }, valid: true },
    { name: 'текст', payload: { q: 'Шантарам' }, valid: true },
    { name: 'один символ — закороткий', payload: { q: 'ш' }, valid: false },
    {
      name: 'усі фільтри',
      payload: { availability: 'ANY', language: 'uk', translation: 'TRANSLATED' },
      valid: true,
    },
    {
      name: 'мова у верхньому регістрі нормалізується',
      payload: { language: ' UK ' },
      valid: true,
    },
    { name: 'невідома мова', payload: { language: 'zz' }, valid: false },
    { name: 'невідома доступність', payload: { availability: 'NOPE' }, valid: false },
    { name: 'невідомий переклад', payload: { translation: 'MAYBE' }, valid: false },
    { name: 'невідомий scope', payload: { scope: 'SECRET' }, valid: false },
    { name: 'розмір сторінки поза набором', payload: { pageSize: '7' }, valid: false },
  ])('$name', ({ payload, valid }) => {
    const byDto = dtoAccepts(CatalogDiscoveryDto, payload)
    const byZod = catalogDiscoveryRequestSchema.safeParse(payload).success

    expect({ byDto, byZod }).toEqual({ byDto: valid, byZod: valid })
  })
})

describe('discoveryScopeViolation — успадкований режим ALL не розвивається', () => {
  const base = {
    scope: 'ALL' as const,
    q: 'книжка',
    availability: 'AVAILABLE' as const,
    translation: 'ANY' as const,
  }

  it('коло: усе дозволено, навіть без тексту', () => {
    expect(
      discoveryScopeViolation({
        ...base,
        scope: 'CIRCLE',
        q: undefined,
        availability: 'ANY',
        language: 'uk',
      }),
    ).toBeNull()
  })

  it('ALL із текстом і без фільтрів — як і раніше', () => {
    expect(discoveryScopeViolation(base)).toBeNull()
  })

  it.each([
    { name: 'без тексту', input: { ...base, q: undefined } },
    { name: 'з доступністю ANY', input: { ...base, availability: 'ANY' as const } },
    { name: 'з мовою', input: { ...base, language: 'uk' } },
    { name: 'з ORIGINAL', input: { ...base, translation: 'ORIGINAL' as const } },
    { name: 'з TRANSLATED', input: { ...base, translation: 'TRANSLATED' as const } },
  ])('ALL $name — відмова', ({ input }) => {
    expect(discoveryScopeViolation(input)).not.toBeNull()
  })

  it('zod-схема застосовує те саме правило', () => {
    expect(catalogDiscoveryRequestSchema.safeParse({ scope: 'ALL' }).success).toBe(false)
    expect(catalogDiscoveryRequestSchema.safeParse({ scope: 'ALL', q: 'книжка' }).success).toBe(
      true,
    )
  })
})

describe('WorkHoldersQueryDto ↔ workHoldersRequestSchema', () => {
  it.each([
    { name: 'порожній', payload: {}, valid: true },
    {
      name: 'переклад і доступність',
      payload: { translationId: 'abc', availability: 'AVAILABLE' },
      valid: true,
    },
    { name: 'original', payload: { translationId: 'original' }, valid: true },
    { name: 'невідома доступність', payload: { availability: 'NOPE' }, valid: false },
    { name: 'порожній translationId', payload: { translationId: '' }, valid: false },
    { name: 'задовгий translationId', payload: { translationId: 'a'.repeat(65) }, valid: false },
  ])('$name', ({ payload, valid }) => {
    expect({
      byDto: dtoAccepts(WorkHoldersQueryDto, payload),
      byZod: workHoldersRequestSchema.safeParse(payload).success,
    }).toEqual({ byDto: valid, byZod: valid })
  })
})
