import { quickAddRequestSchema, quickAddResponseSchema } from './quick-add'

const OPERATION_ID = '3f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11'
const existing = { kind: 'EXISTING_EDITION', editionId: 'edition-1' }

describe('quickAddRequestSchema', () => {
  it('приймає мінімальний запит: ключ дії і наявне видання', () => {
    expect(
      quickAddRequestSchema.safeParse({ operationId: OPERATION_ID, target: existing }).success,
    ).toBe(true)
  })

  it('приймає персональні значення примірника й спосіб додавання', () => {
    const parsed = quickAddRequestSchema.parse({
      operationId: OPERATION_ID,
      entryMethod: 'BARCODE',
      copy: {
        condition: 'WORN',
        visibility: 'PRIVATE',
        note: ' нотатка ',
        acquiredAt: '2026-03-01',
      },
      target: existing,
    })

    expect(parsed.copy?.note).toBe('нотатка')
  })

  it.each([
    ['operationId не UUID', { operationId: 'abc', target: existing }],
    ['немає operationId', { target: existing }],
    ['немає target', { operationId: OPERATION_ID }],
    ['невідомий вид цілі', { operationId: OPERATION_ID, target: { kind: 'OTHER' } }],
    ['ownerId у запиті', { operationId: OPERATION_ID, target: existing, ownerId: 'u1' }],
    [
      'status у copy',
      { operationId: OPERATION_ID, target: existing, copy: { status: 'LENT_OUT' } },
    ],
    [
      'зайве поле в target',
      { operationId: OPERATION_ID, target: { ...existing, isbn13: '9780000000002' } },
    ],
    ['порожній editionId', { operationId: OPERATION_ID, target: { ...existing, editionId: ' ' } }],
  ])('відхиляє: %s', (_name, payload) => {
    expect(quickAddRequestSchema.safeParse(payload).success).toBe(false)
  })
})

describe('quickAddResponseSchema', () => {
  it('вимагає ознаку replay, примірник і каталожний контекст', () => {
    expect(quickAddResponseSchema.safeParse({ operationId: OPERATION_ID }).success).toBe(false)
  })
})
