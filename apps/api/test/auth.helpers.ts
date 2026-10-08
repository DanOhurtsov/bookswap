import { ConfigService } from '@nestjs/config'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { ThrottlerGuard } from '@nestjs/throttler'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/app.setup'
import { BACKGROUND_MODE } from '../src/common/background'
import { DevEmailSender } from '../src/email/dev-email-sender'

export interface TestAppOptions {
  /**
   * `false` вимикає throttler: ліміт реєстрацій — п'ять на годину (§11), а
   * сценаріїв у більшості файлів більше. Те, що ліміт справді працює, перевіряє
   * окремий `rate-limit.e2e-spec.ts` на застосунку зі справжнім guard'ом.
   */
  withRateLimit?: boolean
  /**
   * Те саме, що зробить `main.ts` у production. Без явного значення
   * `configureApp` дивиться на NODE_ENV, а в тестах він `test` — тобто вимкнено.
   */
  trustProxy?: boolean
  /**
   * Підміна провайдерів перед компіляцією модуля.
   *
   * Потрібна рівно одному сценарію — перевірці атомарності §7.3: щоб довести, що
   * падіння на записі сповіщення відкочує весь перехід, це падіння треба вміти
   * влаштувати. Гачок навмисно загальний і без замовчувань: усі наявні виклики
   * `createTestApp()` лишаються незмінними.
   */
  configure?: (builder: TestingModuleBuilder) => void
  /**
   * Чи працює фонова робота за розкладом (`NotificationDispatcher`,
   * `NotificationDigestService`, `SessionCleanupService`).
   *
   * За замовчуванням `false`, і це головне, що робить набір детермінованим.
   * e2e-файли ділять одну базу й один процес, а черга доставки фільтрується
   * ГЛОБАЛЬНО (`claim()`/`reap()` дивляться лише на `status`, `nextAttemptAt` і
   * `attempts`) — тож тик, що збігся з чужим файлом, підбирає й ретраїть чужі
   * доставки. Вимикач закриває обидва шляхи: і таймер, і `wake()`.
   *
   * Сервіси при цьому лишаються в графі — `createTestApp` має бути тим самим
   * застосунком, що й `main.ts`, а не його урізаною копією. Тест, якому прохід
   * потрібен по суті, кличе `run()` явно; `true` тут потрібне лише там, де
   * предметом перевірки є сам `wake()` (див. `graceful-shutdown.e2e-spec.ts`).
   */
  background?: boolean
}

/**
 * Піднімає застосунок так само, як `main.ts` — через `configureApp`, тобто з
 * реальними pipe, фільтром і cookie-parser'ом.
 */
export async function createTestApp({
  withRateLimit = false,
  trustProxy = false,
  configure,
  background = false,
}: TestAppOptions = {}): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({ imports: [AppModule] })

  if (!withRateLimit) {
    builder.overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })
  }

  builder.overrideProvider(BACKGROUND_MODE).useValue(background ? 'enabled' : 'disabled')

  configure?.(builder)

  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<INestApplication<App>>()

  configureApp(app, { trustProxy })

  // Те саме, що `main.ts`: браузер на `WEB_ORIGIN` ходить в API з кукі. Для supertest це нічого не змінює
  // (він не надсилає `Origin`), але без цього `createTestApp()` був би не тим самим застосунком, що `main.ts`,
  // і браузерний e2e (`test:browser`) не міг би працювати проти нього.
  app.enableCors({
    origin: app.get(ConfigService).getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  })

  // `listen(0)`, а не `init()`: один слухач на весь файл.
  //
  // Інакше слухача піднімає supertest — і закриває його після КОЖНОГО запиту
  // (`supertest/lib/test.js`: `serverAddress()` робить `app.listen(0)`, а
  // `end()` — `server.close()`). За прогін це тисячі циклів listen/close на
  // ефемерних портах. Живий слухач прибирає цикл цілком: `serverAddress()`
  // бачить готову адресу, `this._server` не виставляється, `close()` не
  // викликається жодного разу. До `main.ts` це ще й ближче — там теж `listen()`.
  //
  // Чого тут НЕМАЄ і що не варто дописувати «про всяк випадок»: keep-alive.
  // superagent за замовчуванням ходить із `agent: false`
  // (`superagent/lib/node/index.js`), тобто без пулу з'єднань — кожен запит це
  // окремий сокет, закритий одразу після відповіді. Зміряно прямо: за повний
  // прогін `http.globalAgent` не отримує жодного сокета в жодному з 35 файлів.
  //
  // Підстава для цієї правки — вимірювання, а не доведений механізм. Падіння
  // класу «клієнт не отримав коректної HTTP-відповіді» траплялися в 3 із 14
  // прогонів до неї й у 0 із 12 після. Чому саме — не встановлено: найімовірніше
  // з'єднання потрапляє на порт, чий сервер щойно зник, але прямого доказу
  // цього немає.
  await app.listen(0)

  return app
}

let counter = 0

/**
 * Every test file gets its own module registry, so `counter` restarts from zero for each of them
 * while the pid is shared by all the files one process runs. Two files that register the same
 * prefix (`notif-owner`) with the same counter would produce the same address and fail with a 409.
 * A random tag, different for every file, keeps such addresses apart.
 */
const fileTag = Math.random().toString(36).slice(2, 8)

/** Унікальна адреса на кожен виклик: e2e-файли ділять одну тестову базу. */
export function uniqueEmail(prefix = 'user'): string {
  counter += 1

  return `${prefix}-${String(counter)}-${String(process.pid)}-${fileTag}@example.com`
}

export const VALID_PASSWORD = 'dovhyj-parol-2026'

/** `set-cookie` завжди масив рядків; типи supertest про це не знають. */
export function cookiesOf(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie']

  if (Array.isArray(raw)) return raw.map(String)

  return typeof raw === 'string' ? [raw] : []
}

export function sessionCookie(headers: Record<string, unknown>): string {
  const cookie = cookiesOf(headers).find((value) => value.startsWith('bookswap_session='))

  if (cookie === undefined) throw new Error('Відповідь не містить session-кукі')

  // Для наступних запитів потрібна лише пара name=value, без атрибутів.
  return cookie.split(';')[0] ?? ''
}

/**
 * Дістає одноразовий токен із листа. Той самий шлях, яким користується розробник
 * локально: подивитися, що пішло в пошту, і взяти посилання.
 */
export function tokenFromLastEmail(email: DevEmailSender, to: string): string {
  const message = email.lastTo(to)

  if (message === undefined) throw new Error(`Лист на ${to} не надсилався`)

  const match = /token=([A-Za-z0-9_-]+)/.exec(message.body)

  if (match?.[1] === undefined) throw new Error('У листі немає токена')

  return match[1]
}
