import {
  HANDLE_RULES,
  LOAN_TERM_OPTIONS,
  PROFILE_LIMITS,
  citySchema,
  emailSchema,
  handleSchema,
  isReservedHandle,
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

  it('дозволяє явно занулити біо', () => {
    expect(updateProfileRequestSchema.parse({ bio: null })).toEqual({ bio: null })
  })

  it('аватар не є полем редагування (BS-148): фото — лише через POST /me/avatar', () => {
    expect(updateProfileRequestSchema.parse({ avatarUrl: null, bio: null })).toEqual({ bio: null })
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

  it('приймає нік і місто, місто можна занулити (BS-148)', () => {
    expect(updateProfileRequestSchema.parse({ handle: ' Danylo ', city: null })).toEqual({
      handle: 'danylo',
      city: null,
    })
  })

  it('відхиляє нік поза форматом', () => {
    expect(updateProfileRequestSchema.safeParse({ handle: 'ab' }).success).toBe(false)
  })

  it('приймає налаштування позичання; термін можна скинути (BS-148)', () => {
    const settings = {
      friendsOfFriendsAccess: true,
      loanRequestsPaused: true,
      defaultLoanTermDays: 21,
      ownerDueReminders: false,
    }

    expect(updateProfileRequestSchema.parse(settings)).toEqual(settings)
    expect(updateProfileRequestSchema.parse({ defaultLoanTermDays: null })).toEqual({
      defaultLoanTermDays: null,
    })
  })

  it('приймає лише терміни з LOAN_TERM_OPTIONS', () => {
    for (const defaultLoanTermDays of LOAN_TERM_OPTIONS) {
      expect(updateProfileRequestSchema.safeParse({ defaultLoanTermDays }).success).toBe(true)
    }

    for (const defaultLoanTermDays of [0, 7, 15, '14', 14.5]) {
      expect(updateProfileRequestSchema.safeParse({ defaultLoanTermDays }).success).toBe(false)
    }
  })

  it('відхиляє перемикач, який не є boolean', () => {
    expect(updateProfileRequestSchema.safeParse({ loanRequestsPaused: 'true' }).success).toBe(false)
  })
})

describe('handleSchema (BS-148)', () => {
  it('обрізає пробіли на краях і зводить до нижнього регістру', () => {
    expect(handleSchema.parse('  Danylo-Ohurtsov ')).toBe('danylo-ohurtsov')
  })

  it('приймає латиницю, цифри й окремі - та _ між ними', () => {
    for (const handle of [
      'abc',
      'user12345678',
      'danylo-ohurtsov',
      'read_more-2',
      'a'.repeat(30),
    ]) {
      expect(handleSchema.safeParse(handle).success).toBe(true)
    }
  })

  it('відхиляє закороткий, задовгий, з краєвим чи подвійним роздільником, не латиницею', () => {
    for (const handle of [
      'ab',
      'a'.repeat(31),
      '-abc',
      'abc_',
      'ab--cd',
      'ab_-cd',
      'данило',
      'a b c',
      'a.b.c',
    ]) {
      expect(handleSchema.safeParse(handle).success).toBe(false)
    }
  })

  it('пояснює формат одним повідомленням', () => {
    const result = handleSchema.safeParse('ab')

    expect(result.error?.issues[0]?.message).toBe(
      'Лише латинські літери, цифри, - та _, від 3 до 30 символів',
    )
  })

  it('кожен зарезервований нік — валідний за форматом, тож відмова йому — «зайнято», а не «формат»', () => {
    for (const handle of HANDLE_RULES.reserved) {
      expect(handleSchema.safeParse(handle).success).toBe(true)
      expect(isReservedHandle(handle)).toBe(true)
    }

    expect(isReservedHandle('danylo')).toBe(false)
  })
})

describe('citySchema (BS-148)', () => {
  it('обрізає пробіли й обмежує довжину', () => {
    expect(citySchema.parse('  Вроцлав ')).toBe('Вроцлав')
    expect(citySchema.safeParse('м'.repeat(PROFILE_LIMITS.cityMax)).success).toBe(true)
    expect(citySchema.safeParse('м'.repeat(PROFILE_LIMITS.cityMax + 1)).success).toBe(false)
  })

  it('порожнє місто чи самі пробіли — це null, а не порожній рядок', () => {
    expect(citySchema.parse('')).toBeNull()
    expect(citySchema.parse('   ')).toBeNull()
    expect(updateProfileRequestSchema.parse({ city: '  ' })).toEqual({ city: null })
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
    handle: 'marta',
    city: null,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: true,
    friendsOfFriendsAccess: false,
    loanRequestsPaused: false,
    defaultLoanTermDays: null,
    ownerDueReminders: true,
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

  it('несе налаштування позичання (BS-148)', () => {
    expect(meSchema.safeParse({ ...me, defaultLoanTermDays: 30 }).success).toBe(true)
    expect(meSchema.safeParse({ ...me, defaultLoanTermDays: 7 }).success).toBe(false)
    expect(meSchema.safeParse({ ...me, ownerDueReminders: undefined }).success).toBe(false)
  })
})
