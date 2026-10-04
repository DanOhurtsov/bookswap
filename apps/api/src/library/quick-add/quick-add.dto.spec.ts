import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { quickAddRequestSchema } from '@bookswap/shared'
import { QuickAddDto } from './quick-add.dto'

/** Той самий тест парності, що й для решти DTO (§11): однакові вироки zod і class-validator. */
function acceptedByDto(payload: unknown): boolean {
  const instance = plainToInstance(QuickAddDto, payload)

  return (
    validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true }).length === 0
  )
}

const OPERATION_ID = '3f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11'
const target = { kind: 'EXISTING_EDITION', editionId: 'e-1' }

describe('QuickAddDto ↔ quickAddRequestSchema', () => {
  it.each<[string, unknown, boolean]>([
    ['мінімальний запит', { operationId: OPERATION_ID, target }, true],
    [
      'усі поля',
      {
        operationId: OPERATION_ID,
        entryMethod: 'BARCODE',
        copy: { condition: 'WORN', note: 'п', visibility: 'PRIVATE', acquiredAt: '2026-03-01' },
        target,
      },
      true,
    ],
    [
      'null у nullable-полях copy',
      { operationId: OPERATION_ID, copy: { note: null, acquiredAt: null }, target },
      true,
    ],
    ['operationId не UUID', { operationId: 'nope', target }, false],
    ['немає operationId', { target }, false],
    ['немає target', { operationId: OPERATION_ID }, false],
    ['невідомий kind', { operationId: OPERATION_ID, target: { kind: 'X' } }, false],
    ['зайве поле target', { operationId: OPERATION_ID, target: { ...target, isbn13: '1' } }, false],
    ['невідомий спосіб', { operationId: OPERATION_ID, entryMethod: 'CSV', target }, false],
    ['невідомий стан', { operationId: OPERATION_ID, copy: { condition: 'MINT' }, target }, false],
    ['невідома видимість', { operationId: OPERATION_ID, copy: { visibility: 'X' }, target }, false],
    ['status у copy', { operationId: OPERATION_ID, copy: { status: 'LENT_OUT' }, target }, false],
    [
      'невалідна дата',
      { operationId: OPERATION_ID, copy: { acquiredAt: '2026-13-01' }, target },
      false,
    ],
    [
      'надто довга нотатка',
      { operationId: OPERATION_ID, copy: { note: 'я'.repeat(1001) }, target },
      false,
    ],
    ['зайве поле верхнього рівня', { operationId: OPERATION_ID, ownerId: 'u', target }, false],
  ])('%s', (name, payload, valid) => {
    const byZod = quickAddRequestSchema.safeParse(payload).success
    const byDto = acceptedByDto(payload)

    expect({ name, byZod, byDto }).toEqual({ name, byZod: valid, byDto: valid })
  })
})
