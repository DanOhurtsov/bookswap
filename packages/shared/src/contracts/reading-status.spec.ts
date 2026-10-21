import {
  READING_STATUS_BATCH_LIMITS,
  parseWorkIdList,
  readingListItemSchema,
  readingListQueryRequestSchema,
  readingListResponseSchema,
  readingStatusResponseSchema,
  readingStatusesQueryRequestSchema,
  readingStatusesResponseSchema,
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

  it('GET-відповідь має isSet і wasBorrowed і не має зайвого', () => {
    const ok = { workId: 'w', status: 'NOT_READ', isSet: false, wasBorrowed: false }

    expect(readingStatusResponseSchema.safeParse(ok).success).toBe(true)
    expect(readingStatusResponseSchema.safeParse({ ...ok, userId: 'u' }).success).toBe(false)
    expect(
      readingStatusResponseSchema.safeParse({ workId: 'w', status: 'READ', wasBorrowed: false })
        .success,
    ).toBe(false)
    expect(readingStatusResponseSchema.safeParse({ workId: 'w', status: 'READ' }).success).toBe(
      false,
    )
  })

  it('пакетна відповідь: кожен елемент несе requestedWorkId і той самий стан, що й одиночний GET', () => {
    const element = {
      requestedWorkId: 'w-old',
      workId: 'w',
      status: 'READ',
      isSet: true,
      wasBorrowed: false,
    }

    expect(readingStatusesResponseSchema.safeParse({ items: [element] }).success).toBe(true)
    expect(readingStatusesResponseSchema.safeParse({ items: [] }).success).toBe(true)
    expect(
      readingStatusesResponseSchema.safeParse({ items: [{ ...element, userId: 'u' }] }).success,
    ).toBe(false)

    const { requestedWorkId: _omitted, ...withoutRequested } = element

    expect(readingStatusesResponseSchema.safeParse({ items: [withoutRequested] }).success).toBe(
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

describe('parseWorkIdList / readingStatusesQueryRequestSchema', () => {
  it('зливає повтори в порядку першої появи', () => {
    expect(parseWorkIdList('b,a,b,c,a')).toEqual(['b', 'a', 'c'])
    expect(readingStatusesQueryRequestSchema.parse({ workIds: 'b,a,b' })).toEqual({
      workIds: ['b', 'a'],
    })
  })

  it('рівно 100 унікальних ID приймає; 101 — ні, навіть якщо повтори дають довший рядок', () => {
    const hundred = Array.from({ length: READING_STATUS_BATCH_LIMITS.idsMax }, (_, i) => `w${i}`)

    expect(parseWorkIdList(hundred.join(','))).toHaveLength(100)
    expect(parseWorkIdList([...hundred, 'w0', 'w1'].join(','))).toHaveLength(100)
    expect(parseWorkIdList([...hundred, 'extra'].join(','))).toBeUndefined()
  })

  it.each([
    ['порожній рядок', ''],
    ['порожній елемент', 'a,,b'],
    ['кома в кінці', 'a,'],
    ['пробіл', 'a, b'],
    ['задовгий ID', 'x'.repeat(65)],
    ['задовгий сирий рядок', 'a,'.repeat(READING_STATUS_BATCH_LIMITS.queryMax)],
  ])('відхиляє: %s', (_name, raw) => {
    expect(parseWorkIdList(raw)).toBeUndefined()
    expect(readingStatusesQueryRequestSchema.safeParse({ workIds: raw }).success).toBe(false)
  })

  it('інших параметрів і масиву замість рядка не приймає', () => {
    expect(readingStatusesQueryRequestSchema.safeParse({ workIds: ['a', 'b'] }).success).toBe(false)
    expect(readingStatusesQueryRequestSchema.safeParse({ workIds: 'a', userId: 'u' }).success).toBe(
      false,
    )
    expect(readingStatusesQueryRequestSchema.safeParse({}).success).toBe(false)
  })
})
