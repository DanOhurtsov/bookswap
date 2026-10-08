import {
  confirmPasswordResetRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  sessionResponseSchema,
} from './auth'

describe('registerRequestSchema', () => {
  const valid = { email: 'Marta@Example.COM', password: 'dovhyj-parol', displayName: '  Марта  ' }

  it('нормалізує email до нижнього регістру й обрізає імʼя', () => {
    expect(registerRequestSchema.parse(valid)).toEqual({
      email: 'marta@example.com',
      password: 'dovhyj-parol',
      displayName: 'Марта',
    })
  })

  it('відхиляє некоректний email', () => {
    expect(registerRequestSchema.safeParse({ ...valid, email: 'марта' }).success).toBe(false)
  })

  it('відхиляє закороткий пароль', () => {
    expect(registerRequestSchema.safeParse({ ...valid, password: 'корот' }).success).toBe(false)
  })

  it('відхиляє задовгий пароль — scrypt на мегабайті це DoS', () => {
    expect(registerRequestSchema.safeParse({ ...valid, password: 'a'.repeat(201) }).success).toBe(
      false,
    )
  })

  it('відхиляє імʼя з одного символу', () => {
    expect(registerRequestSchema.safeParse({ ...valid, displayName: 'М' }).success).toBe(false)
  })

  it('не обрізає пароль — пробіли в ньому значущі', () => {
    const parsed = registerRequestSchema.parse({ ...valid, password: '  parol z probilamy  ' })

    expect(parsed.password).toBe('  parol z probilamy  ')
  })
})

describe('loginRequestSchema', () => {
  it('не застосовує політику довжини до наявного пароля', () => {
    // Інакше «закороткий пароль» відрізняв би акаунт зі старим паролем від
    // неіснуючого — і форма входу стала б підказкою.
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true)
  })

  it('відхиляє порожній пароль', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false)
  })
})

describe('confirmPasswordResetRequestSchema', () => {
  it('вимагає і токен, і новий пароль за політикою', () => {
    expect(
      confirmPasswordResetRequestSchema.safeParse({ token: 'abc', password: 'novyj-parol' })
        .success,
    ).toBe(true)
    expect(
      confirmPasswordResetRequestSchema.safeParse({ token: '', password: 'novyj-parol' }).success,
    ).toBe(false)
    expect(
      confirmPasswordResetRequestSchema.safeParse({ token: 'abc', password: 'korot' }).success,
    ).toBe(false)
  })
})

describe('sessionResponseSchema', () => {
  const user = {
    id: 'u-1',
    email: 'a@example.com',
    emailVerified: true,
    displayName: 'Марта',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-09-27T10:00:00.000Z',
  }

  it.each([true, false])('несе доступність гостьових позик (%s)', (guestLoans) => {
    expect(sessionResponseSchema.parse({ user, features: { guestLoans } }).features).toEqual({
      guestLoans,
    })
  })

  it('відхиляє відповідь без features або з нелогічним значенням', () => {
    expect(sessionResponseSchema.safeParse({ user }).success).toBe(false)
    expect(
      sessionResponseSchema.safeParse({ user, features: { guestLoans: 'true' } }).success,
    ).toBe(false)
  })
})
