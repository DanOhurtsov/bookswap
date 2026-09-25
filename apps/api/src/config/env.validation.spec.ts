import { envSchema, validateEnv } from './env.validation'

const DB_URL = 'postgresql://bookswap:dev@localhost:5432/bookswap?schema=public'

/** Мінімум, без якого застосунок не має стартувати. */
const required = { DATABASE_URL: DB_URL, DIRECT_DATABASE_URL: DB_URL }

describe('validateEnv', () => {
  it('заповнює дефолти для змінних без явного значення', () => {
    const result = validateEnv({ ...required, NODE_ENV: 'test' })

    expect(result.PORT).toBe(3001)
    expect(result.WEB_ORIGIN).toBe('http://localhost:3000')
  })

  it('приводить PORT із рядка до числа', () => {
    expect(validateEnv({ ...required, PORT: '4000' }).PORT).toBe(4000)
  })

  it('зберігає ще не описані схемою змінні', () => {
    const result = validateEnv({ ...required, TEST_DATABASE_URL: DB_URL })

    expect(result.TEST_DATABASE_URL).toBe(DB_URL)
  })

  it('вимагає обидва URL бази — дефолтів у них немає', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/)
    expect(() => validateEnv({ DATABASE_URL: DB_URL })).toThrow(/DIRECT_DATABASE_URL/)
  })

  it('не приймає URL іншого протоколу замість постгресівського', () => {
    expect(() => validateEnv({ ...required, DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(
      /postgresql/,
    )
  })

  it('падає на старті при некоректному значенні, а не мовчки бере дефолт', () => {
    expect(() => validateEnv({ ...required, PORT: 'not-a-port' })).toThrow(/Некоректне оточення/)
    expect(() => validateEnv({ ...required, WEB_ORIGIN: 'локалхост' })).toThrow(
      /Некоректне оточення/,
    )
    expect(() => validateEnv({ ...required, NODE_ENV: 'staging' })).toThrow(/Некоректне оточення/)
  })

  it('дефолти схеми відповідають .env.example', () => {
    const parsed = envSchema.parse(required)

    expect(parsed).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: DB_URL,
      DIRECT_DATABASE_URL: DB_URL,
      // §7.2: свіжий клон працює без жодного зовнішнього провайдера.
      EMAIL_PROVIDER: 'dev',
      CATALOG_WRITE_RATE_LIMIT: 30,
      CATALOG_WRITE_RATE_WINDOW_MS: 3600000,
      CATALOG_LOOKUP_RATE_LIMIT: 20,
      CATALOG_LOOKUP_RATE_WINDOW_MS: 60000,
      // Stage 8f-2, R7a: бюджет fallback-провайдерів у CSV-імпорті.
      CATALOG_LOOKUP_FALLBACK_BUDGET: 50,
      CATALOG_LOOKUP_FALLBACK_CONCURRENCY: 4,
      LIBRARY_IMPORT_PREVIEW_RATE_LIMIT: 5,
      LIBRARY_IMPORT_PATCH_RATE_LIMIT: 120,
      LIBRARY_IMPORT_RATE_WINDOW_MS: 60000,
    })
  })

  /**
   * R7: контакт провайдера не має дефолту НАВМИСНО. Порожнє значення означає
   * «контакту немає» — підставляти сюди чиюсь адресу за замовчуванням значило б
   * скерувати чужі скарги на людину, яка про це не просила.
   */
  it('контакт провайдера не має дефолтного значення', () => {
    expect(envSchema.parse(required).CATALOG_LOOKUP_CONTACT).toBeUndefined()
  })
})

describe('пошта (§7.2)', () => {
  it('за замовчуванням — dev-провайдер, без ключів', () => {
    expect(validateEnv(required).EMAIL_PROVIDER).toBe('dev')
  })

  it('resend вимагає ключ і відправника', () => {
    expect(() => validateEnv({ ...required, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/)
    expect(() =>
      validateEnv({ ...required, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' }),
    ).toThrow(/EMAIL_FROM/)
    expect(() =>
      validateEnv({
        ...required,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_x',
        EMAIL_FROM: 'BookSwap <hi@example.com>',
      }),
    ).not.toThrow()
  })

  /**
   * `DevEmailSender` нічого не надсилає й пише одноразові токени в лог. Раніше
   * це ловив його конструктор, але з появою другого провайдера сам факт
   * існування об'єкта в контейнері перестав означати його використання — тож
   * перевірка переїхала сюди, де видно саме **вибір**.
   */
  it('у production dev-провайдер заборонений', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production' })).toThrow(/EMAIL_PROVIDER/)
    expect(() =>
      validateEnv({
        ...required,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_x',
        EMAIL_FROM: 'BookSwap <hi@example.com>',
        INVITE_EMAIL_HMAC_SECRET: 's'.repeat(32),
      }),
    ).not.toThrow()
  })

  describe('INVITE_EMAIL_HMAC_SECRET (Етап 9)', () => {
    const production = {
      ...required,
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'BookSwap <hi@example.com>',
    }

    it('у production обов’язковий', () => {
      expect(() => validateEnv(production)).toThrow(/INVITE_EMAIL_HMAC_SECRET/)
    })

    it('коротший за 32 символи відхиляється в будь-якому середовищі', () => {
      expect(() => validateEnv({ ...production, INVITE_EMAIL_HMAC_SECRET: 'short' })).toThrow(
        /INVITE_EMAIL_HMAC_SECRET/,
      )
      expect(() => validateEnv({ ...required, INVITE_EMAIL_HMAC_SECRET: 'short' })).toThrow(
        /INVITE_EMAIL_HMAC_SECRET/,
      )
    })

    it('поза production ключ необов’язковий', () => {
      expect(() => validateEnv(required)).not.toThrow()
    })
  })
})

describe('Telegram (§7.4)', () => {
  const bot = {
    TELEGRAM_BOT_TOKEN: '123456:AAExampleToken',
    TELEGRAM_BOT_USERNAME: 'bookswap_bot',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
  }

  it('повний комплект приймається', () => {
    expect(() => validateEnv({ ...required, ...bot })).not.toThrow()
  })

  it('жодної змінної — теж коректно: бот опційний', () => {
    expect(() => validateEnv(required)).not.toThrow()
  })

  /**
   * Часткова конфігурація гірша за жодну: токен без імені бота не дає зібрати
   * deep link, а токен без секрету лишає `POST /webhooks/telegram` — єдиний
   * маршрут без сесії — відкритим.
   */
  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'])(
    'без %s комплект не приймається',
    (missing) => {
      const partial: Record<string, unknown> = { ...required, ...bot }
      delete partial[missing]

      expect(() => validateEnv(partial)).toThrow(/комплектом/)
    },
  )

  it('секрет мусить пройти обмеження Telegram на символи й довжину', () => {
    expect(() =>
      validateEnv({ ...required, ...bot, TELEGRAM_WEBHOOK_SECRET: 'закороткий' }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/)
    expect(() =>
      validateEnv({ ...required, ...bot, TELEGRAM_WEBHOOK_SECRET: `${'a'.repeat(30)}!@#` }),
    ).toThrow(/A-Z/)
  })

  it('ім’я бота — без @ і в межах, які дозволяє Telegram', () => {
    expect(() =>
      validateEnv({ ...required, ...bot, TELEGRAM_BOT_USERNAME: '@bookswap_bot' }),
    ).toThrow(/TELEGRAM_BOT_USERNAME/)
    expect(() => validateEnv({ ...required, ...bot, TELEGRAM_BOT_USERNAME: 'bot' })).toThrow(
      /TELEGRAM_BOT_USERNAME/,
    )
  })
})
