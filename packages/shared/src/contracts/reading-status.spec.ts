import {
  readingListItemSchema,
  readingListQueryRequestSchema,
  readingListResponseSchema,
  readingStatusResponseSchema,
  setReadingStatusRequestSchema,
  setReadingStatusResponseSchema,
} from './reading-status'

const work = {
  id: 'work-1',
  title: 'Шантарам',
  origLang: 'en',
  firstPubYear: 2003,
  description: null,
  createdAt: '2026-03-01T10:00:00.000Z',
  revision: 1,
}

const item = {
  work,
  authors: [],
  status: 'READ',
  wasBorrowed: true,
  updatedAt: '2026-03-01T10:00:00.000Z',
}

describe('setReadingStatusRequestSchema', () => {
  it.each(['NOT_READ', 'READING', 'READ'])('приймає %s', (status) => {
    expect(setReadingStatusRequestSchema.safeParse({ status }).success).toBe(true)
  })

  it.each([
    ['невідомий статус', { status: 'DONE' }],
    ['без статусу', {}],
    ['зайве поле', { status: 'READ', userId: 'u-1' }],
    ['нижній регістр', { status: 'read' }],
  ])('відхиляє: %s', (_name, payload) => {
    expect(setReadingStatusRequestSchema.safeParse(payload).success).toBe(false)
  })
})

describe('відповіді', () => {
  it('PUT-відповідь строга', () => {
    expect(setReadingStatusResponseSchema.safeParse({ workId: 'w', status: 'READ' }).success).toBe(
      true,
    )
    expect(
      setReadingStatusResponseSchema.safeParse({ workId: 'w', status: 'READ', wasBorrowed: true })
        .success,
    ).toBe(false)
  })

  it('GET-відповідь має wasBorrowed і не має зайвого', () => {
    const ok = { workId: 'w', status: 'NOT_READ', wasBorrowed: false }

    expect(readingStatusResponseSchema.safeParse(ok).success).toBe(true)
    expect(readingStatusResponseSchema.safeParse({ ...ok, userId: 'u' }).success).toBe(false)
    expect(readingStatusResponseSchema.safeParse({ workId: 'w', status: 'READ' }).success).toBe(
      false,
    )
  })

  it('елемент списку: явний NOT_READ неможливий, зайві поля відхилено', () => {
    expect(readingListItemSchema.safeParse(item).success).toBe(true)
    expect(readingListItemSchema.safeParse({ ...item, status: 'NOT_READ' }).success).toBe(false)
    expect(readingListItemSchema.safeParse({ ...item, userId: 'u-1' }).success).toBe(false)
  })

  it('список несе nextCursor', () => {
    expect(readingListResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(
      true,
    )
    expect(readingListResponseSchema.safeParse({ items: [item] }).success).toBe(false)
  })
})

describe('readingListQueryRequestSchema', () => {
  it.each([
    ['порожній', {}, true],
    ['READ', { status: 'READ' }, true],
    ['READING', { status: 'READING' }, true],
    ['NOT_READ не фільтр', { status: 'NOT_READ' }, false],
    ['limit 50', { limit: '50' }, true],
    ['limit 51', { limit: '51' }, false],
    ['limit 0', { limit: '0' }, false],
    ['limit не число', { limit: 'ten' }, false],
    ['порожній cursor', { cursor: '' }, false],
    ['зайве поле', { userId: 'u' }, false],
  ])('%s', (_name, payload, valid) => {
    expect(readingListQueryRequestSchema.safeParse(payload).success).toBe(valid)
  })
})
