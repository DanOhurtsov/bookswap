import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { searchCandidatesRequestSchema } from '@bookswap/shared'
import { SearchCandidatesQueryDto } from './search-candidates-query.dto'

/**
 * Той самий тест парності, що й для `CatalogSearchDto` (`catalog.dto.spec.ts`):
 * §11 вимагає і zod, і class-validator, і обидва мусять сходитись у вироку.
 */
function acceptedByDto(payload: unknown): boolean {
  const instance = plainToInstance(SearchCandidatesQueryDto, payload)

  return validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }).length === 0
}

describe('SearchCandidatesQueryDto ↔ searchCandidatesRequestSchema', () => {
  it.each([
    { name: 'валідний запит за назвою', payload: { q: 'Шантарам' }, valid: true },
    { name: 'валідний ISBN у тому самому полі', payload: { q: '9783161484100' }, valid: true },
    { name: 'один символ — закороткий', payload: { q: 'ш' }, valid: false },
    { name: 'порожній рядок', payload: { q: '' }, valid: false },
    { name: 'відсутнє поле q', payload: {}, valid: false },
  ])('$name', ({ payload, valid }) => {
    const byZod = searchCandidatesRequestSchema.safeParse(payload).success
    const byDto = acceptedByDto(payload)

    expect({ byZod, byDto }).toEqual({ byZod: valid, byDto: valid })
  })

  it.each([
    { name: 'pageSize 12', payload: { q: 'Шантарам', pageSize: '12' }, valid: true },
    { name: 'pageSize 48', payload: { q: 'Шантарам', pageSize: '48' }, valid: true },
    {
      name: 'межа дублікатів (10) явно — не розмір',
      payload: { q: 'Шантарам', pageSize: '10' },
      valid: false,
    },
    { name: 'колишній pageSize 20', payload: { q: 'Шантарам', pageSize: '20' }, valid: false },
  ])('$name', ({ payload, valid }) => {
    const byZod = searchCandidatesRequestSchema.safeParse(payload).success
    const byDto = acceptedByDto(payload)

    expect({ byZod, byDto }).toEqual({ byZod: valid, byDto: valid })
  })

  it('без pageSize розмір не підставляється: межу перевірки дублікатів вирішує сервер, а не типовий розмір списку', () => {
    expect(plainToInstance(SearchCandidatesQueryDto, { q: 'Шантарам' }).pageSize).toBeUndefined()
    expect(searchCandidatesRequestSchema.parse({ q: 'Шантарам' }).pageSize).toBeUndefined()
  })

  it('явний pageSize — число, як у списку', () => {
    expect(
      plainToInstance(SearchCandidatesQueryDto, { q: 'Шантарам', pageSize: '24' }).pageSize,
    ).toBe(24)
  })

  it('обрізає зайві пробіли так само, як схема', () => {
    const instance = plainToInstance(SearchCandidatesQueryDto, { q: '  Шантарам  ' })

    expect(instance.q).toBe('Шантарам')
  })
})
