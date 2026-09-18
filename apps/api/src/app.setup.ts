import { HttpStatus, Logger, ValidationPipe, type INestApplication } from '@nestjs/common'
import {
  API_ERROR_CODES,
  API_PREFIX,
  LIBRARY_IMPORT_CONTENT_BASE64_MAX,
  type LibraryImportTooLargeDetails,
} from '@bookswap/shared'
import cookieParser from 'cookie-parser'
import { json, type Express, type NextFunction, type Request, type Response } from 'express'
import { ApiException } from './common/api.exception'
import { AllExceptionsFilter } from './common/all-exceptions.filter'

/** The base64 payload plus room for the JSON envelope around it. */
const IMPORT_BODY_LIMIT = LIBRARY_IMPORT_CONTENT_BASE64_MAX + 1024

const importBodyParser = json({ limit: IMPORT_BODY_LIMIT })

/** `http-errors` shape produced by body-parser. `body` is deliberately never read. */
interface BodyParserError {
  type?: unknown
  length?: unknown
}

/**
 * Turns a body-parser rejection into the API's own error.
 *
 * Nothing from the request is echoed or logged. body-parser attaches the raw
 * text it choked on to some of these errors, and that text is the person's CSV
 * — base64 of their library, private notes and all. It stays where it is: the
 * answer says what went wrong, never what was sent.
 */
function bodyParserFailure(error: unknown): ApiException | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const { type, length } = error as BodyParserError

  if (type === 'entity.too.large') {
    return new ApiException(
      API_ERROR_CODES.IMPORT_TOO_LARGE,
      'Запит перевищує дозволений розмір',
      HttpStatus.PAYLOAD_TOO_LARGE,
      {
        limit: 'REQUEST_BYTES',
        max: IMPORT_BODY_LIMIT,
        // Declared `Content-Length`. Absent for a chunked upload — unknown, and
        // the CSV's own size is certainly not known here: the body was never read.
        ...(typeof length === 'number' && length > 0 ? { actual: length } : {}),
      } satisfies LibraryImportTooLargeDetails,
    )
  }

  if (typeof type !== 'string' || !type.startsWith('entity.')) return undefined

  return new ApiException(
    API_ERROR_CODES.VALIDATION_ERROR,
    'Тіло запиту не є коректним JSON',
    HttpStatus.BAD_REQUEST,
  )
}

export interface AppSetupOptions {
  /**
   * Довіряти заголовку `X-Forwarded-For` рівно від одного проксі.
   *
   * За замовчуванням — лише у production, і це не обережність заради обережності.
   * §13.2: у проді перед застосунком стоїть Caddy, тож без `trust proxy` Express
   * бачить IP контейнера проксі — один і той самий для всіх. Rate limiting (§11)
   * тоді рахує спроби входу глобально: перший, хто вичерпає ліміт, замикає вхід
   * усім іншим.
   *
   * Локально ж проксі немає, і `X-Forwarded-For` цілком контролюється клієнтом.
   * Довіряти йому в dev означало б роздати спосіб обійти будь-який ліміт зміною
   * одного заголовка.
   *
   * Саме `1`, а не `true`: довіряється рівно один стрибок — найближчий проксі.
   * З `true` Express бере найлівіший IP із ланцюжка, а туди пише клієнт.
   */
  trustProxy?: boolean
}

/**
 * Глобальна конфігурація застосунку.
 *
 * Живе окремо від `main.ts` навмисно: e2e-тести піднімають застосунок тим самим
 * викликом, тож перевіряють справжню конфігурацію, а не свою копію.
 */
export function configureApp(app: INestApplication, options: AppSetupOptions = {}): void {
  const trustProxy = options.trustProxy ?? process.env.NODE_ENV === 'production'

  if (trustProxy) {
    // `getInstance()` типізований як any — платформа адаптера в сигнатурі не
    // відображена. Звуження безпечне: у проєкті єдиний адаптер — platform-express.
    const express = app.getHttpAdapter().getInstance() as Express

    express.set('trust proxy', 1)
    new Logger('AppSetup').log('trust proxy = 1: IP клієнта береться з X-Forwarded-For')
  }

  app.setGlobalPrefix(API_PREFIX)

  // Stage 8f-2: CSV приїжджає як base64 у JSON, тож тіло саме цього маршруту
  // більше за дефолтні 100 KiB body-parser'а (48 KiB файла → ~64 KiB base64, а
  // трохи більший файл мусить дійти до парсера, щоб дістати IMPORT_TOO_LARGE з
  // правдивим розміром). Ліміт піднімається ЛИШЕ тут, а не глобально: решта
  // API не має причин приймати більші тіла.
  //
  // Реєструється до `app.init()`, тому спрацьовує першим, а власний JSON-парсер
  // Nest бачить уже розібране тіло й пропускає його (`req._body`).
  //
  // Обгортка з ВЛАСНИМ іменем тут обов'язкова. `ExpressAdapter` Nest реєструє
  // свій глобальний парсер лише тоді, коли на стеку ще немає middleware з
  // іменем `jsonParser` — а саме так зветься функція, яку повертає
  // `json()`. Передати її напряму означало б, що Nest вважає парсер уже
  // встановленим і НЕ додасть глобальний: тіло розбиралося б рівно на одному
  // маршруті, а всі інші ендпоінти мовчки почали б бачити порожній `body`.
  const previewPath = `${API_PREFIX}/me/library/imports/preview`

  app.use(
    previewPath,
    function libraryImportBodyParser(
      request: Request,
      response: Response,
      next: NextFunction,
    ): void {
      importBodyParser(request, response, next)
    },
  )

  // Without this the parser's own rejection reaches the global filter as an
  // unrecognized error and becomes a 500 — a server fault reported for a
  // request that was simply too big. Four parameters is what makes Express
  // treat this as an error handler.
  app.use(
    previewPath,
    function libraryImportBodyError(
      error: unknown,
      _request: Request,
      _response: Response,
      next: NextFunction,
    ): void {
      next(bodyParserFailure(error) ?? error)
    },
  )

  // §6.1: сесія живе в кукі, тож її треба спершу розібрати. Express 5 цього не
  // вміє сам — cookie-parser лишається обов'язковим.
  app.use(cookieParser())

  // §11: рантайм-валідація DTO через class-validator на кожному ендпоінті.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Без цього query-параметри лишаються рядками, а `@IsBoolean`/`@IsIn` на
      // них не спрацьовують так, як описано в DTO.
      transformOptions: { enableImplicitConversion: false },
    }),
  )

  app.useGlobalFilters(new AllExceptionsFilter())
}
