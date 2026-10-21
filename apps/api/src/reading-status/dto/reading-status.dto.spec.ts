import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  readingListQueryRequestSchema,
  readingStatusesQueryRequestSchema,
  setReadingStatusRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import {
  ReadingListQueryDto,
  ReadingStatusesQueryDto,
  SetReadingStatusDto,
} from './reading-status.dto'

/** Той самий тест парності, що й для решти DTO (§11): вироки zod і class-validator збігаються. */
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

describe('SetReadingStatusDto ↔ setReadingStatusRequestSchema', () => {
  it('вироки збігаються', () => {
    expectAgreement(SetReadingStatusDto, setReadingStatusRequestSchema, [
      { name: 'NOT_READ', payload: { status: 'NOT_READ' }, valid: true },
      { name: 'READING', payload: { status: 'READING' }, valid: true },
      { name: 'READ', payload: { status: 'READ' }, valid: true },
      { name: 'невідомий', payload: { status: 'DONE' }, valid: false },
      { name: 'регістр', payload: { status: 'read' }, valid: false },
      { name: 'без статусу', payload: {}, valid: false },
      { name: 'не рядок', payload: { status: 1 }, valid: false },
      { name: 'зайве поле', payload: { status: 'READ', userId: 'u' }, valid: false },
    ])
  })
})

describe('ReadingListQueryDto ↔ readingListQueryRequestSchema', () => {
  it('вироки збігаються', () => {
    expectAgreement(ReadingListQueryDto, readingListQueryRequestSchema, [
      { name: 'порожній', payload: {}, valid: true },
      { name: 'READ', payload: { status: 'READ' }, valid: true },
      { name: 'READING', payload: { status: 'READING' }, valid: true },
      { name: 'NOT_READ', payload: { status: 'NOT_READ' }, valid: false },
      { name: 'limit 1', payload: { limit: '1' }, valid: true },
      { name: 'limit 50', payload: { limit: '50' }, valid: true },
      { name: 'limit 51', payload: { limit: '51' }, valid: false },
      { name: 'limit 0', payload: { limit: '0' }, valid: false },
      { name: 'limit 007', payload: { limit: '007' }, valid: false },
      { name: 'limit 100', payload: { limit: '100' }, valid: false },
      { name: 'limit текст', payload: { limit: 'ten' }, valid: false },
      { name: 'cursor', payload: { cursor: 'abc' }, valid: true },
      { name: 'порожній cursor', payload: { cursor: '' }, valid: false },
      { name: 'довгий cursor', payload: { cursor: 'a'.repeat(257) }, valid: false },
      { name: 'зайве поле', payload: { userId: 'u' }, valid: false },
    ])
  })
})

describe('ReadingStatusesQueryDto ↔ readingStatusesQueryRequestSchema (BS-140)', () => {
  const ids = (count: number): string =>
    Array.from({ length: count }, (_, index) => `w${String(index)}`).join(',')

  it('вироки збігаються', () => {
    expectAgreement(ReadingStatusesQueryDto, readingStatusesQueryRequestSchema, [
      { name: 'один ID', payload: { workIds: 'w-1' }, valid: true },
      { name: 'кілька', payload: { workIds: 'w-1,w-2' }, valid: true },
      { name: 'повтори', payload: { workIds: 'w-1,w-1,w-2' }, valid: true },
      { name: '100 унікальних', payload: { workIds: ids(100) }, valid: true },
      { name: '101 унікальний', payload: { workIds: ids(101) }, valid: false },
      { name: '100 + повтори', payload: { workIds: `${ids(100)},w0,w1` }, valid: true },
      { name: 'порожній', payload: { workIds: '' }, valid: false },
      { name: 'порожній елемент', payload: { workIds: 'w-1,,w-2' }, valid: false },
      { name: 'пробіл', payload: { workIds: 'w-1, w-2' }, valid: false },
      { name: 'задовгий ID', payload: { workIds: 'x'.repeat(65) }, valid: false },
      { name: 'повторений параметр', payload: { workIds: ['w-1', 'w-2'] }, valid: false },
      { name: 'без параметра', payload: {}, valid: false },
      { name: 'зайве поле', payload: { workIds: 'w-1', userId: 'u-1' }, valid: false },
    ])
  })

  it('після розбору DTO несе унікальні ID у порядку першої появи', () => {
    const dto = plainToInstance(ReadingStatusesQueryDto, { workIds: 'b,a,b' })

    expect(dto.workIds).toEqual(['b', 'a'])
  })
})
