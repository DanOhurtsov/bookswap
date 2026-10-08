import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { readingListQueryRequestSchema, setReadingStatusRequestSchema } from '@bookswap/shared'
import type { ZodType } from 'zod'
import { ReadingListQueryDto, SetReadingStatusDto } from './reading-status.dto'

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
