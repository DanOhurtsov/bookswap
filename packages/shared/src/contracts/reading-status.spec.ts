import {
  READING_STATUS_BATCH_LIMITS,
  friendsReadingQueryRequestSchema,
  friendsReadingResponseSchema,
  parseWorkIdList,
  readingListItemSchema,
  readingListQueryRequestSchema,
  readingListResponseSchema,
  readingStatsResponseSchema,
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

describe('readingStatsResponseSchema (BS-145)', () => {
  it('accepts all three counts, zeros included', () => {
    expect(
      readingStatsResponseSchema.safeParse({ counts: { NOT_READ: 0, READING: 2, READ: 0 } })
        .success,
    ).toBe(true)
  })

  it.each([
    ['a missing status', { NOT_READ: 0, READING: 1 }],
    ['an unknown status', { NOT_READ: 0, READING: 1, READ: 2, ABANDONED: 1 }],
    ['a negative count', { NOT_READ: -1, READING: 1, READ: 2 }],
    ['a fractional count', { NOT_READ: 0.5, READING: 1, READ: 2 }],
    ['a count as a string', { NOT_READ: '1', READING: 1, READ: 2 }],
  ])('rejects %s', (_case, counts) => {
    expect(readingStatsResponseSchema.safeParse({ counts }).success).toBe(false)
  })

  it('rejects anything beside the counts, such as a user id', () => {
    expect(
      readingStatsResponseSchema.safeParse({
        counts: { NOT_READ: 0, READING: 0, READ: 0 },
        userId: 'user-1',
      }).success,
    ).toBe(false)
  })
})

describe('friendsReadingResponseSchema (BS-137)', () => {
  const friendItem = {
    friend: { id: 'user-2', displayName: 'Марта', handle: 'marta', avatarUrl: null },
    work: { id: 'work-1', title: 'Шантарам' },
    authors: [{ id: 'a-1', name: 'Ґреґорі Робертс', nameLatin: null, role: 'AUTHOR', position: 0 }],
    coverUrl: 'https://covers.example/1.jpg',
    updatedAt: '2026-03-01T10:00:00.000Z',
  }
  const page = { hasFriends: true, items: [friendItem], nextCursor: 'abc' }

  it('приймає сторінку з записами, без обкладинки й обидва порожні стани', () => {
    expect(friendsReadingResponseSchema.safeParse(page).success).toBe(true)
    expect(
      friendsReadingResponseSchema.safeParse({
        ...page,
        items: [{ ...friendItem, coverUrl: null }],
        nextCursor: null,
      }).success,
    ).toBe(true)
    expect(
      friendsReadingResponseSchema.safeParse({ hasFriends: true, items: [], nextCursor: null })
        .success,
    ).toBe(true)
    expect(
      friendsReadingResponseSchema.safeParse({ hasFriends: false, items: [], nextCursor: null })
        .success,
    ).toBe(true)
  })

  it.each([
    ['зайве поле сторінки', { ...page, total: 1 }],
    [
      'email друга',
      { ...page, items: [{ ...friendItem, friend: { ...friendItem.friend, email: 'm@x.ua' } }] },
    ],
    [
      'налаштування друга',
      {
        ...page,
        items: [{ ...friendItem, friend: { ...friendItem.friend, libraryVisibility: 'FRIENDS' } }],
      },
    ],
    [
      'опис твору',
      { ...page, items: [{ ...friendItem, work: { ...friendItem.work, description: 'd' } }] },
    ],
    ['статус у записі', { ...page, items: [{ ...friendItem, status: 'READING' }] }],
    [
      'зайве поле автора',
      { ...page, items: [{ ...friendItem, authors: [{ ...friendItem.authors[0], bio: 'b' }] }] },
    ],
    ['без hasFriends', { items: [], nextCursor: null }],
    ['hasFriends не булеве', { ...page, hasFriends: 'yes' }],
    ['без обкладинки взагалі', { ...page, items: [{ ...friendItem, coverUrl: undefined }] }],
    ['дата не ISO', { ...page, items: [{ ...friendItem, updatedAt: 'вчора' }] }],
    ['без друга', { ...page, items: [{ ...friendItem, friend: undefined }] }],
    ['записи без друзів', { hasFriends: false, items: [friendItem], nextCursor: null }],
    ['курсор без друзів', { hasFriends: false, items: [], nextCursor: 'abc' }],
  ])('відхиляє: %s', (_name, payload) => {
    expect(friendsReadingResponseSchema.safeParse(payload).success).toBe(false)
  })
})

describe('friendsReadingQueryRequestSchema (BS-137)', () => {
  it.each([{}, { limit: '1' }, { limit: '12' }, { limit: '48' }, { cursor: 'abc' }])(
    'приймає %j',
    (query) => {
      expect(friendsReadingQueryRequestSchema.safeParse(query).success).toBe(true)
    },
  )

  it.each([
    { limit: '0' },
    { limit: '49' },
    { limit: '012' },
    { limit: 'ten' },
    { cursor: '' },
    { cursor: 'a'.repeat(257) },
    { userId: 'user-2' },
  ])('відхиляє %j', (query) => {
    expect(friendsReadingQueryRequestSchema.safeParse(query).success).toBe(false)
  })
})
