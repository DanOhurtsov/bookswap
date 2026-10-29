import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  loginRequestSchema,
  registerRequestSchema,
  updateProfileRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import { UpdateProfileDto } from '../../users/dto/user.dto'
import { LoginDto, RegisterDto } from './auth.dto'

/**
 * §11 вимагає обидва механізми: `class-validator` у рантаймі Nest і zod-схеми в
 * `packages/shared` для спільного з фронтом контракту. Плата за це — ризик, що
 * два описи однієї структури розійдуться.
 *
 * Тест закриває саме його: ті самі дані йдуть крізь обидва механізми, і вирок
 * мусить збігтися. Розсинхрон стає червоним тестом, а не 500-ю на проді.
 */
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

describe('RegisterDto ↔ registerRequestSchema', () => {
  const base = { email: 'marta@example.com', password: 'dovhyj-parol', displayName: 'Марта' }

  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(RegisterDto, registerRequestSchema, [
      { name: 'коректні дані', payload: base, valid: true },
      { name: 'email без @', payload: { ...base, email: 'marta' }, valid: false },
      { name: 'пароль на межі', payload: { ...base, password: 'a'.repeat(10) }, valid: true },
      {
        name: 'пароль на символ коротший',
        payload: { ...base, password: 'a'.repeat(9) },
        valid: false,
      },
      {
        name: 'пароль на межі згори',
        payload: { ...base, password: 'a'.repeat(200) },
        valid: true,
      },
      { name: 'пароль задовгий', payload: { ...base, password: 'a'.repeat(201) }, valid: false },
      { name: 'імʼя на межі', payload: { ...base, displayName: 'Ма' }, valid: true },
      { name: 'імʼя з одного символу', payload: { ...base, displayName: 'М' }, valid: false },
      { name: 'імʼя задовге', payload: { ...base, displayName: 'М'.repeat(81) }, valid: false },
      { name: 'бракує пароля', payload: { email: base.email, displayName: 'Марта' }, valid: false },
    ])
  })

  it('нормалізує так само, як zod', () => {
    const payload = { ...base, email: '  Marta@Example.COM ', displayName: '  Марта  ' }
    const dto = plainToInstance(RegisterDto, payload)
    const parsed = registerRequestSchema.parse(payload)

    expect(dto.email).toBe(parsed.email)
    expect(dto.displayName).toBe(parsed.displayName)
  })

  /**
   * BS-129: the blocked-domain policy is not syntax. Both validators accept the
   * address; the refusal belongs to `AuthService.register()`, so login and
   * password reset keep accepting the same address for an existing account.
   */
  it('однаково пропускають синтаксично коректну адресу на заблокованому домені', () => {
    expectAgreement(RegisterDto, registerRequestSchema, [
      { name: 'адреса на .ru', payload: { ...base, email: 'marta@example.ru' }, valid: true },
      { name: 'піддомен .su', payload: { ...base, email: 'marta@mail.example.su' }, valid: true },
    ])
    expectAgreement(LoginDto, loginRequestSchema, [
      { name: 'вхід на .ru', payload: { email: 'marta@example.ru', password: 'x' }, valid: true },
    ])
  })

  it('не чіпає пароль при нормалізації — пробіли в ньому значущі', () => {
    const dto = plainToInstance(RegisterDto, { ...base, password: '  parol z probilamy  ' })

    expect(dto.password).toBe('  parol z probilamy  ')
  })
})

describe('LoginDto ↔ loginRequestSchema', () => {
  it('обидва пропускають короткий наявний пароль', () => {
    expectAgreement(LoginDto, loginRequestSchema, [
      { name: 'короткий пароль', payload: { email: 'a@b.co', password: 'x' }, valid: true },
      { name: 'порожній пароль', payload: { email: 'a@b.co', password: '' }, valid: false },
      { name: 'кривий email', payload: { email: 'a', password: 'x' }, valid: false },
    ])
  })
})

describe('UpdateProfileDto ↔ updateProfileRequestSchema', () => {
  it('однаково ставиться до кожного поля окремо', () => {
    expectAgreement(UpdateProfileDto, updateProfileRequestSchema, [
      { name: 'зміна імені', payload: { displayName: 'Марта К.' }, valid: true },
      // BS-148: the photo changes only through POST /me/avatar; neither side takes an address.
      {
        name: 'аватар більше не поле профілю',
        payload: { avatarUrl: 'https://cdn.example.com/a.png' },
        valid: false,
      },
      { name: 'занулення біо', payload: { bio: null }, valid: true },
      { name: 'біо задовге', payload: { bio: 'я'.repeat(501) }, valid: false },
      { name: 'видимість PRIVATE', payload: { libraryVisibility: 'PRIVATE' }, valid: true },
      { name: 'невідома видимість', payload: { libraryVisibility: 'SECRET' }, valid: false },
      { name: 'showHolderNames рядком', payload: { showHolderNames: 'так' }, valid: false },
      { name: 'showHolderNames булевим', payload: { showHolderNames: false }, valid: true },
    ])
  })

  it('однаково ставиться до налаштувань позичання (BS-148)', () => {
    expectAgreement(UpdateProfileDto, updateProfileRequestSchema, [
      { name: 'друзі друзів', payload: { friendsOfFriendsAccess: true }, valid: true },
      { name: 'друзі друзів null', payload: { friendsOfFriendsAccess: null }, valid: false },
      { name: 'пауза', payload: { loanRequestsPaused: false }, valid: true },
      { name: 'пауза рядком', payload: { loanRequestsPaused: 'true' }, valid: false },
      { name: 'пауза null', payload: { loanRequestsPaused: null }, valid: false },
      { name: 'термін 14', payload: { defaultLoanTermDays: 14 }, valid: true },
      { name: 'термін 30', payload: { defaultLoanTermDays: 30 }, valid: true },
      { name: 'термін скинуто', payload: { defaultLoanTermDays: null }, valid: true },
      { name: 'термін 7', payload: { defaultLoanTermDays: 7 }, valid: false },
      { name: 'термін рядком', payload: { defaultLoanTermDays: '21' }, valid: false },
      { name: 'нагадування', payload: { ownerDueReminders: false }, valid: true },
      { name: 'нагадування null', payload: { ownerDueReminders: null }, valid: false },
    ])
  })

  /**
   * Єдина свідома розбіжність: «жодного поля» zod ловить через `.refine`, а
   * class-validator такого правила про пару полів не виражає — його перевіряє
   * контролер. Тест фіксує це, щоб розбіжність лишалася явною, а не забутою.
   */
  it('порожнє тіло: zod відхиляє, DTO пропускає — перевірку робить контролер', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false)
    expect(acceptedByDto(UpdateProfileDto, {})).toBe(true)
  })
})
