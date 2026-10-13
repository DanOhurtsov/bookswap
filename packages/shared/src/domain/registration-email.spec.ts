import { registerRequestSchema, loginRequestSchema } from '../contracts/auth'
import { emailSchema } from '../contracts/user'
import {
  BLOCKED_REGISTRATION_EMAIL_DOMAIN_SUFFIXES,
  EMAIL_DOMAIN_BLOCKED_MESSAGE,
  isRegistrationEmailDomainBlocked,
} from './registration-email'

const registration = (email: string) => ({
  email,
  password: 'dovhyj-parol-2026',
  displayName: 'Марта',
})

describe('isRegistrationEmailDomainBlocked', () => {
  it('тримає погоджений список суфіксів і текст відмови', () => {
    expect(BLOCKED_REGISTRATION_EMAIL_DOMAIN_SUFFIXES).toEqual([
      'ru',
      'рф',
      'su',
      'рус',
      'moscow',
      'москва',
    ])
    expect(EMAIL_DOMAIN_BLOCKED_MESSAGE).toBe(
      'Реєстрація з цією поштовою адресою недоступна. Використайте email з іншим доменом.',
    )
  })

  it.each(BLOCKED_REGISTRATION_EMAIL_DOMAIN_SUFFIXES)(
    'блокує домен .%s, його піддомени, змішаний регістр і зовнішні пробіли',
    (suffix) => {
      expect(isRegistrationEmailDomainBlocked(`user@example.${suffix}`)).toBe(true)
      expect(isRegistrationEmailDomainBlocked(`user@mail.corp.example.${suffix}`)).toBe(true)
      expect(
        isRegistrationEmailDomainBlocked(`  User@Mail.Example.${suffix.toUpperCase()}  `),
      ).toBe(true)
    },
  )

  it.each([
    ['рф', 'xn--p1ai'],
    ['рус', 'xn--p1acf'],
    ['москва', 'xn--80adxhks'],
  ])('блокує .%s і в Unicode, і в Punycode (.%s)', (unicode, punycode) => {
    expect(isRegistrationEmailDomainBlocked(`user@пошта.${unicode}`)).toBe(true)
    expect(isRegistrationEmailDomainBlocked(`user@ПОШТА.${unicode.toUpperCase()}`)).toBe(true)
    expect(isRegistrationEmailDomainBlocked(`user@example.${punycode}`)).toBe(true)
    expect(isRegistrationEmailDomainBlocked(`user@Mail.Example.${punycode.toUpperCase()}`)).toBe(
      true,
    )
    expect(isRegistrationEmailDomainBlocked(`user@xn--80a1acn3a.${punycode}`)).toBe(true)
  })

  it('порівнює домен після IDNA-відображення: крапки-варіанти й кінцева крапка не обходять список', () => {
    expect(isRegistrationEmailDomainBlocked('user@mail.example。ru')).toBe(true)
    expect(isRegistrationEmailDomainBlocked('user@mail.example．рф')).toBe(true)
    expect(isRegistrationEmailDomainBlocked('user@example.ru.')).toBe(true)
  })

  it('блокує за Unicode-суфіксом і тоді, коли IDNA не може перетворити мітку', () => {
    expect(isRegistrationEmailDomainBlocked('user@�.ru')).toBe(true)
    expect(isRegistrationEmailDomainBlocked('user@xn--zz.рф')).toBe(true)
  })

  it.each([
    'user@example.com',
    'user@example.com.ua',
    'user@example.ru.com',
    'user@notru.com',
    'ru.user@example.com',
    'user@xn--e1afmkfd.com',
    'user.ru@example.com',
    'user@example.рф.com',
    'user@example.su.org',
    'user@moscow.example.com',
    'user@ru',
  ])('не блокує %s', (email) => {
    expect(isRegistrationEmailDomainBlocked(email)).toBe(false)
  })

  it('дозволені адреси далі проходять звичайну валідацію реєстрації', () => {
    for (const email of ['user@example.com', 'user@example.ru.com', 'ru.user@example.com']) {
      expect(registerRequestSchema.safeParse(registration(email)).success).toBe(true)
    }
  })

  /**
   * Path, port, userinfo, query, fragment, percent-escapes and whitespace must not
   * turn into "the domain" through the URL parser: such a value is not blocked by
   * the policy and stays a plain format error.
   */
  it.each([
    'user@example.com/x.ru',
    'user@example.ru/',
    'user@example.ru:80',
    'user@example.ru:25',
    'user@example.ru@evil.com',
    'user@evil.com?.ru',
    'user@evil.com#.ru',
    'user@exa%2eru',
    'user@example%2Eru',
    'user@[example.ru]',
    'user@example .ru',
    'user@example\t.ru',
    'user@example\\.ru',
    'user@.ru',
    'user@example..ru',
    '@example.ru',
    'user@',
    'example.ru',
  ])(
    'URL-подібне чи некоректне %j не маскується під домен і лишається помилкою формату',
    (email) => {
      expect(isRegistrationEmailDomainBlocked(email)).toBe(false)
      expect(registerRequestSchema.safeParse(registration(email)).success).toBe(false)
    },
  )

  it('не входить у синтаксичну валідацію: emailSchema і вхід приймають наявну адресу на .ru', () => {
    expect(emailSchema.safeParse('user@example.ru').success).toBe(true)
    expect(registerRequestSchema.safeParse(registration('user@example.ru')).success).toBe(true)
    expect(loginRequestSchema.safeParse({ email: 'user@example.ru', password: 'x' }).success).toBe(
      true,
    )
  })
})
