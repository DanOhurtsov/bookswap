import {
  PROFILE_LIMITS,
  emailSchema,
  meSchema,
  updateProfileRequestSchema,
  userSearchQuerySchema,
  userSearchRequestSchema,
} from './user'

describe('updateProfileRequestSchema', () => {
  it('дозволяє часткове оновлення', () => {
    expect(updateProfileRequestSchema.parse({ bio: 'Читаю фантастику' })).toEqual({
      bio: 'Читаю фантастику',
    })
  })

  it('дозволяє явно занулити аватар і біо', () => {
    expect(updateProfileRequestSchema.parse({ avatarUrl: null, bio: null })).toEqual({
      avatarUrl: null,
      bio: null,
    })
  })

  it('відхиляє порожнє тіло — «зміни нічого» це не запит', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false)
  })

  it('відхиляє невідоме значення видимості', () => {
    expect(updateProfileRequestSchema.safeParse({ libraryVisibility: 'SECRET' }).success).toBe(
      false,
    )
  })

  it('приймає всі три значення Visibility (§4.2)', () => {
    for (const libraryVisibility of ['PUBLIC', 'FRIENDS', 'PRIVATE']) {
      expect(updateProfileRequestSchema.safeParse({ libraryVisibility }).success).toBe(true)
    }
  })

  it('відхиляє аватар, який не є URL', () => {
    expect(updateProfileRequestSchema.safeParse({ avatarUrl: '/uploads/1.png' }).success).toBe(
      false,
    )
  })
})

describe('userSearchRequestSchema', () => {
  it('приймає пошук за імʼям', () => {
    expect(userSearchRequestSchema.parse({ q: 'Мар' })).toEqual({ q: 'Мар' })
  })

  it('нормалізує email так само, як у реєстрації', () => {
    expect(userSearchRequestSchema.parse({ email: ' Marta@Example.com ' })).toEqual({
      email: 'marta@example.com',
    })
  })

  it('вимагає рівно один параметр', () => {
    expect(userSearchRequestSchema.safeParse({}).success).toBe(false)
    expect(userSearchRequestSchema.safeParse({ q: 'Мар', email: 'a@b.co' }).success).toBe(false)
  })

  it('не шукає за одним символом — це вже перебір бази', () => {
    expect(userSearchRequestSchema.safeParse({ q: 'М' }).success).toBe(false)
  })

  it('приймає одне поле query й обрізає зовнішні пробіли', () => {
    expect(userSearchRequestSchema.parse({ query: '  Мар  ' })).toEqual({ query: 'Мар' })
  })

  it('не поєднує query зі старими параметрами', () => {
    expect(userSearchRequestSchema.safeParse({ query: 'Мар', q: 'Мар' }).success).toBe(false)
    expect(userSearchRequestSchema.safeParse({ query: 'Мар', email: 'a@b.co' }).success).toBe(false)
  })
})

describe('userSearchQuerySchema', () => {
  it('вимагає щонайменше два символи після обрізання', () => {
    expect(userSearchQuerySchema.safeParse(' М ').success).toBe(false)
    expect(userSearchQuerySchema.safeParse('   ').success).toBe(false)
    expect(userSearchQuerySchema.parse(' Ма ')).toBe('Ма')
  })

  it('вміщує email-адресу найбільшої допустимої довжини, але не довшу', () => {
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.ua`

    expect(longest).toHaveLength(PROFILE_LIMITS.emailMax)
    expect(emailSchema.safeParse(longest).success).toBe(true)
    expect(userSearchQuerySchema.parse(longest)).toBe(longest)
    expect(userSearchQuerySchema.safeParse(`${longest}a`).success).toBe(false)
  })
})

describe('meSchema', () => {
  const me = {
    id: 'user-1',
    email: 'marta@example.com',
    emailVerified: true,
    displayName: 'Марта',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: true,
    createdAt: '2026-08-15T10:00:00.000Z',
  }

  it('приймає повний профіль власника', () => {
    expect(meSchema.safeParse(me).success).toBe(true)
  })

  it('не має поля passwordHash у типі — зайве відкидається при парсингу', () => {
    const parsed = meSchema.parse({ ...me, passwordHash: 'scrypt$...' })

    expect(parsed).not.toHaveProperty('passwordHash')
  })

  it('вимагає ISO-дату створення', () => {
    expect(meSchema.safeParse({ ...me, createdAt: '15.08.2026' }).success).toBe(false)
  })
})
