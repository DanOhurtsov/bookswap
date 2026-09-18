import { z } from 'zod'

/**
 * Підключення до PostgreSQL. Схема лише перевіряє, що це схожий на постгресівський
 * URL — розбирати креденшели тут не наше діло, це робить драйвер.
 */
const postgresUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'очікується postgresql:// URL',
  )

/**
 * §7.4: Telegram дозволяє в `secret_token` рівно `A-Z a-z 0-9 _ -`, 1–256 символів,
 * і саме це значення повертає нам у заголовку `X-Telegram-Bot-Api-Secret-Token`.
 * Ширший секрет бот просто не прийме в `setWebhook` — краще впасти на старті, ніж
 * дізнатися про це, коли вебхук мовчить.
 */
const telegramWebhookSecret = z
  .string()
  .min(16, 'щонайменше 16 символів — секрет захищає єдиний неавтентифікований маршрут')
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Telegram приймає лише A-Z, a-z, 0-9, _ і -')

/**
 * Валідація оточення на старті, fail-fast.
 *
 * `TEST_DATABASE_URL` тут свідомо немає: вона потрібна лише `pnpm test:db` і не є
 * вимогою до застосунку. Невідомі ключі схема не відкидає, тож вона просто
 * проходить наскрізь.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3001),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

    /** Рантайм-клієнт через драйвер-адаптер. У проді — через PgBouncer. */
    DATABASE_URL: postgresUrl,
    /**
     * §4.1: пряме підключення для міграцій. Дефолту немає навмисно — мовчазний
     * фолбек на `DATABASE_URL` означав би, що в проді міграції підуть через пулер
     * і зависнуть на advisory lock, а помітиться це лише під час деплою.
     */
    DIRECT_DATABASE_URL: postgresUrl,

    /**
     * §7.2: який саме `EmailSender` підняти.
     *
     * Явний перемикач, а не «є ключ — значить Resend»: виведення з наявності
     * ключа означає, що забутий у проді `RESEND_API_KEY` тихо відкочує систему
     * на dev-реалізацію, яка нічого не надсилає. Тут же неправильна комбінація
     * зупиняє старт.
     */
    EMAIL_PROVIDER: z.enum(['dev', 'resend']).default('dev'),
    /**
     * §11, R2: ліміт на створення Work/Translation/Edition і його вікно.
     * Дефолти дублюють фолбек у rate-limit.config.ts — схема тут для того,
     * щоб криве значення падало на старті, а не тихо ставало дефолтом.
     */
    CATALOG_WRITE_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    CATALOG_WRITE_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60_000),
    /**
     * §11, R2, docs/plan/stage-7.md 7b: ліміт на `GET /catalog/lookup` і його
     * вікно. Окремий бакет від `CATALOG_WRITE_RATE_LIMIT` — див.
     * `common/rate-limit.config.ts` про різницю в природі захисту. Дефолти
     * тут дублюють фолбек у `rate-limit.config.ts` з тієї ж причини, що й у
     * write-ліміту: криве значення мусить падати на старті, а не тихо ставати
     * дефолтом.
     */
    CATALOG_LOOKUP_RATE_LIMIT: z.coerce.number().int().positive().default(20),
    CATALOG_LOOKUP_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Stage 8f-2, R7a: скільки ISBN одного preview можуть дійти до одиночних
     * fallback-провайдерів і скільки таких запитів летить одночасно. Ліміт
     * рахує ISBN, не HTTP-виклики: двоє провайдерів — це до вдвічі більше
     * запитів на той самий бюджет.
     */
    CATALOG_LOOKUP_FALLBACK_BUDGET: z.coerce.number().int().positive().default(50),
    CATALOG_LOOKUP_FALLBACK_CONCURRENCY: z.coerce.number().int().positive().default(4),
    /**
     * R7: контакт у `User-Agent` для Open Library. Порожнє значення означає
     * «контакту немає» — заголовок тоді несе лише назву застосунку, і жодна
     * персональна адреса не підставляється за замовчуванням.
     */
    CATALOG_LOOKUP_CONTACT: z.string().optional(),
    /** §4, Stage 8f-2: окремий бакет CSV-імпорту — preview і PATCH рядка. */
    LIBRARY_IMPORT_PREVIEW_RATE_LIMIT: z.coerce.number().int().positive().default(5),
    LIBRARY_IMPORT_PATCH_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    LIBRARY_IMPORT_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /** Ключ Resend. Обов'язковий лише для `EMAIL_PROVIDER=resend` — див. superRefine. */
    RESEND_API_KEY: z.string().min(1).optional(),
    /** Відправник у форматі `Name <address@domain>` або просто адреси. */
    EMAIL_FROM: z.string().min(1).optional(),

    /**
     * §7.4: бот. Усі три змінні — разом або жодної.
     *
     * Токен без імені бота дав би канал, у який нема як завести користувача
     * (deep link збирається з імені); токен без секрету лишив би `POST
     * /webhooks/telegram` — єдиний маршрут без сесії — відкритим для будь-кого,
     * хто знає адресу. Обидві половини перевіряються нижче.
     */
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    /** Ім'я бота без `@`: з нього збирається `t.me/<bot>?start=<token>`. */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .regex(/^[A-Za-z0-9_]{5,32}$/, 'ім’я бота — 5–32 символи з A-Z, a-z, 0-9, _ і без @')
      .optional(),
    TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret.optional(),
  })
  .superRefine((env, ctx) => {
    /**
     * `DevEmailSender` у проді заборонений, і причина не в тому, що він
     * «несправжній»: він нічого не надсилає (підтвердження пошти мовчки не
     * працює) і друкує тіло листа з одноразовим токеном у лог. Перевірка стоїть
     * тут, а не в конструкторі сендера: після появи другого провайдера сам факт
     * існування об'єкта в контейнері перестав означати його використання.
     */
    if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER === 'dev') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message:
          'у production потрібен справжній провайдер (resend): dev нічого не надсилає ' +
          'і пише одноразові токени в лог',
      })
    }

    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'обов’язкова при EMAIL_PROVIDER=resend',
          })
        }
      }
    }

    // Три змінні бота — комплект. Часткова конфігурація гірша за жодну: вона
    // виглядає як «Telegram налаштований», а поводиться як зламаний.
    const telegram = [
      ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN],
      ['TELEGRAM_BOT_USERNAME', env.TELEGRAM_BOT_USERNAME],
      ['TELEGRAM_WEBHOOK_SECRET', env.TELEGRAM_WEBHOOK_SECRET],
    ] as const
    const missing = telegram.filter(([, value]) => value === undefined)

    if (missing.length !== 0 && missing.length !== telegram.length) {
      for (const [key] of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'змінні Telegram задаються комплектом — або всі три, або жодної',
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

/**
 * Повертає вихідне оточення, збагачене розібраними та типізованими значеннями.
 * Невідомі ключі не відкидаються — інакше ConfigService втратив би все, що ще не
 * описане схемою (те саме `DATABASE_URL` на наступному етапі).
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config)

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')

    throw new Error(`Некоректне оточення:\n${issues}`)
  }

  return { ...config, ...result.data }
}
