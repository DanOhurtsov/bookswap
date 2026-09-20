import { z } from 'zod'

/**
 * §8: помилки API мають машиночитний `code`.
 *
 * Тут лише **загальні інфраструктурні** коди — ті, без яких не працює транспортний
 * рівень. Доменні коди (`LOAN_*`, `FRIENDSHIP_*`, `COPY_*` тощо) свідомо не
 * заводяться наперед: кожен приходить разом зі своєю функціональністю, інакше
 * половина каталогу лишиться мертвою або розійдеться з реальною поведінкою.
 */
export const API_ERROR_CODES = {
  /** Тіло чи параметри запиту не пройшли валідацію (HTTP 400). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Синтаксично коректний, але неприйнятний запит без окремішнього коду (405, 415, …). */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Немає автентифікації (HTTP 401). */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Автентифікація є, прав бракує (HTTP 403). */
  FORBIDDEN: 'FORBIDDEN',
  /** Ресурс не знайдено (HTTP 404). */
  NOT_FOUND: 'NOT_FOUND',
  /** Конфлікт стану — напр. порушення унікальності (HTTP 409). */
  CONFLICT: 'CONFLICT',
  /** Спрацював rate limiting §11 (HTTP 429). */
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  /** Непередбачена помилка сервера (HTTP 5xx). Деталі назовні не віддаються. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // --- Акаунт і сесії (§6.1) -------------------------------------------------
  /** Реєстрація на вже зайнятий email (HTTP 409). */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /**
   * Логін не вдався (HTTP 401). Один код і на невідомий email, і на хибний
   * пароль: різні коди перетворили б форму входу на перевірку «чи є такий акаунт».
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Одноразовий токен із листа недійсний: не існує, прострочений або вже використаний (HTTP 400). */
  INVALID_TOKEN: 'INVALID_TOKEN',

  // --- Дружба (§6.2, §8) -----------------------------------------------------
  /** Запит у друзі самому собі (HTTP 400). */
  FRIENDSHIP_SELF: 'FRIENDSHIP_SELF',
  /** Пара вже існує: люди друзі або запит уже висить (HTTP 409). */
  FRIENDSHIP_EXISTS: 'FRIENDSHIP_EXISTS',
  /**
   * Пара заблокована (HTTP 403). §6.2: заблокований не бачить бібліотеку й не може
   * надсилати запити. Тим самим кодом відповідає й спроба зняти чужий блок.
   */
  FRIENDSHIP_BLOCKED: 'FRIENDSHIP_BLOCKED',
  /** Дія неможлива в поточному статусі дружби (HTTP 409). */
  FRIENDSHIP_INVALID_TRANSITION: 'FRIENDSHIP_INVALID_TRANSITION',

  // --- Каталог і бібліотека (§6.3–6.4, §8) -----------------------------------
  /**
   * ISBN-13 уже належить іншому виданню (HTTP 409). `details: { editionId }` —
   * саме тому цей випадок має власний код: клієнт не показує помилку, а веде
   * людину до наявного видання, де їй лишається створити тільки `Copy` (§6.3).
   */
  EDITION_ISBN_TAKEN: 'EDITION_ISBN_TAKEN',
  /**
   * Примірник не можна видалити, поки є лоан у `APPROVED` або `HANDED_OVER`
   * (§5.2, HTTP 409). Окремий код, бо дія користувача тут інша: не «спробуйте
   * ще раз», а «спершу заберіть книжку».
   */
  COPY_HAS_ACTIVE_LOAN: 'COPY_HAS_ACTIVE_LOAN',
  /**
   * Власник не може перемкнути `status` просто зараз: книжка не вдома або має
   * активний лоан (HTTP 409). Стосується **лише** поля `status` — решта полів
   * примірника редагується завжди.
   */
  COPY_STATUS_LOCKED: 'COPY_STATUS_LOCKED',
  /**
   * The addressed `Work` was merged into another one (§6.3, R4).
   *
   * One code, two statuses. Reads answer 301 with a `Location` header, as §6.3
   * requires. Writes answer 409 instead: silently retargeting a POST to a record
   * the client never named would hide the move from the only party that can
   * decide whether it still wants to write there.
   *
   * `details.canonicalWorkId` carries the work to use instead — the point of a
   * dedicated code is that the client can retarget itself rather than show an
   * error.
   */
  WORK_MERGED: 'WORK_MERGED',
  /**
   * Stage 8e-1/8e-2, R9: `PATCH /works|translations|editions/:id` надіслано зі
   * застарілим `expectedRevision` (HTTP 409). Клієнт отримує код і свіжу
   * сутність для повторного рішення — без silent overwrite.
   */
  CATALOG_REVISION_CONFLICT: 'CATALOG_REVISION_CONFLICT',
  /**
   * Stage 8e-1/8e-2, R8: людина не є creator сутності й не володіє жодним `Copy`,
   * що дає право редагувати (HTTP 403). Право володіння не дає права видаляти,
   * мержити чи переносити сутність до іншого Work.
   */
  CATALOG_EDIT_FORBIDDEN: 'CATALOG_EDIT_FORBIDDEN',

  // --- ISBN lookup (§6.3, §11, docs/plan/stage-7.md 7b) -----------------------
  /**
   * Зовнішній провайдер не знає такого ISBN (HTTP 404). Окремий код від
   * загального `NOT_FOUND`: тут немає локального ресурсу, є лише порожня
   * відповідь стороннього API — клієнт має пропонувати ручне заповнення форми,
   * а не «перевірте адресу».
   */
  CATALOG_LOOKUP_NOT_FOUND: 'CATALOG_LOOKUP_NOT_FOUND',
  /**
   * Зовнішній провайдер відповів помилкою або незрозумілим тілом (HTTP 502).
   * Не 500: це збій чужого сервісу, а не нашого коду, і клієнт має пропонувати
   * ручне заповнення форми, а не показувати «щось зламалося в нас».
   */
  CATALOG_LOOKUP_PROVIDER_ERROR: 'CATALOG_LOOKUP_PROVIDER_ERROR',
  /**
   * Зовнішній провайдер не відповів у межах таймауту (HTTP 504,
   * `CATALOG_LOOKUP_TIMEOUT_MS`, дефолт 5с — див. `.env.example`).
   */
  CATALOG_LOOKUP_TIMEOUT: 'CATALOG_LOOKUP_TIMEOUT',

  // --- CSV library import (docs/plan/stage-8-inventory.md, R4–R6, §4) ---------
  /**
   * The file exceeds a whole-file cap. `details: { limit, max, actual }`
   * (`libraryImportTooLargeDetailsSchema`): `BYTES` — 48 KiB as received,
   * checked before parsing; `ROWS` — 200 data rows; `COPIES` — 500 in total.
   */
  IMPORT_TOO_LARGE: 'IMPORT_TOO_LARGE',
  /**
   * The file is not a CSV v1 import at all — encoding, delimiter, header or
   * record structure — so there are no rows to report errors on.
   * `details.reason` (`libraryImportInvalidCsvDetailsSchema`) says which.
   */
  IMPORT_INVALID_CSV: 'IMPORT_INVALID_CSV',
  /**
   * Stage 8f-4 (agreed PO decision): the uploaded `.xlsx` is not a library
   * import — the container, the workbook's shape or a cell we refuse to read.
   * `details.reason` (`libraryImportInvalidXlsxDetailsSchema`) says which, and
   * names the sheet, row and column wherever they are known.
   *
   * Separate from `IMPORT_INVALID_CSV` because the two share no reason: the
   * failures of a ZIP full of XML and of a line of delimited text have nothing
   * in common but the moment they are found.
   */
  IMPORT_INVALID_XLSX: 'IMPORT_INVALID_XLSX',
  /**
   * Stage 8f-2, R6a: the owner's own draft outlived its 24 h TTL (HTTP 410). Its
   * rows are already deleted, so there is nothing left to read or resolve — the
   * only way forward is to send the file again, which revives the same import
   * with a new TTL. A `COMMITTED` import never reaches this code: it does not
   * expire, and always answers with its previous summary.
   */
  IMPORT_EXPIRED: 'IMPORT_EXPIRED',
  /**
   * Stage 8f-2 (agreed): the row a `PATCH` was computed from has changed since
   * the client read it (HTTP 409).
   *
   * The case this exists for is a slow one: a `RETRY` waits on a provider, the
   * owner skips that row meanwhile, and the retry comes back to a row that is no
   * longer the one it was asked about. Applying it would silently undo the skip,
   * so the whole operation is refused instead — nothing is written. The body
   * carries no draft content; the client re-reads the draft and decides again.
   */
  IMPORT_ROW_CONFLICT: 'IMPORT_ROW_CONFLICT',
  /**
   * Stage 8g, R6c: the draft cannot be committed as it stands (HTTP 409).
   *
   * One code for every such answer, with `details.reason`
   * (`libraryImportNotReadyDetailsSchema`) saying which: unresolved rows,
   * nothing left to import, an ISBN group whose rows disagree about what to
   * create, a draft that changed under the request, a chosen `Work` that was
   * merged away or speaks another original language, or an `Edition` that
   * appeared between the preview and the commit.
   *
   * Deliberately not seven top-level codes. For the client every one of them is
   * the same sentence — "this draft cannot be imported right now, and here are
   * the rows" — followed by the same act: re-read the draft and fix the named
   * rows. `details` carries `rowNumbers` only, never row content: a private
   * `note` has no business travelling back inside an error.
   */
  IMPORT_NOT_READY: 'IMPORT_NOT_READY',

  // --- Позичання (§5, §8) ----------------------------------------------------
  /** Запит на позичання власного примірника (HTTP 400). Інваріант §5.3.4. */
  LOAN_SELF: 'LOAN_SELF',
  /**
   * Примірник не можна попросити просто зараз: він не `AVAILABLE` або не вдома
   * (HTTP 409). Окремий код від `LOAN_INVALID_TRANSITION`, бо це стан **речі**,
   * а не стан домовленості: клієнту треба перечитати полицю, а не лоан.
   */
  LOAN_COPY_UNAVAILABLE: 'LOAN_COPY_UNAVAILABLE',
  /**
   * У цієї людини вже висить `REQUESTED` на цей примірник (HTTP 409). §5.1
   * забороняє **власний** повторний запит; чужі одночасні запити дозволені.
   */
  LOAN_DUPLICATE_REQUEST: 'LOAN_DUPLICATE_REQUEST',
  /**
   * Дія неможлива з поточного статусу лоану (HTTP 409) — рядок таблиці §5.1, якого
   * не існує. Сюди ж потрапляє програвший гонку апруву: поки він чекав на
   * блокування, його запит уже відхилили як конкурента.
   */
  LOAN_INVALID_TRANSITION: 'LOAN_INVALID_TRANSITION',
  /**
   * Перехід сам по собі можливий, але `Copy` не в очікуваному стані (HTTP 409):
   * примірник змінили в обхід стейт-машини, і дані розʼїхалися. Окремий код, бо
   * дія користувача тут інша — не «спробуйте пізніше», а «перезавантажте
   * сторінку, полиця вже не така».
   */
  LOAN_COPY_STATE_MISMATCH: 'LOAN_COPY_STATE_MISMATCH',
  /**
   * На примірнику вже є ексклюзивний лоан (HTTP 409) — порушення часткового
   * унікального індексу `one_active_loan_per_copy` (§5.3.1).
   *
   * За коректного `SELECT … FOR UPDATE` сюди дійти майже неможливо: конкурент
   * побачить свій запит уже відхиленим і отримає `LOAN_INVALID_TRANSITION`. Код
   * існує тому, що індекс — остання лінія оборони, і його спрацювання мусить
   * стати доменною помилкою, а не 500.
   */
  LOAN_ALREADY_APPROVED: 'LOAN_ALREADY_APPROVED',

  // --- Зовнішні канали сповіщень (§7.2, §7.4) --------------------------------
  /**
   * Бот не налаштований на цьому середовищі (HTTP 503): немає
   * `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`, тож deep link нема з чого
   * зібрати. Окремий код, бо це не помилка користувача й не «спробуйте пізніше»,
   * а відсутня конфігурація — UI має сховати кнопку, а не показати відмову.
   */
  TELEGRAM_NOT_CONFIGURED: 'TELEGRAM_NOT_CONFIGURED',
  /**
   * Спроба відв'язати Telegram, якого не було, або ввімкнути канал `TELEGRAM`
   * для акаунта без `chat_id` (HTTP 409). Створювати `NotificationDelivery` у
   * нікуди не можна: рядок п'ять разів невдало спробував би надіслати й ліг би
   * у `FAILED`, вдаючи збій каналу замість відсутньої прив'язки.
   */
  TELEGRAM_NOT_LINKED: 'TELEGRAM_NOT_LINKED',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

// Object.values() втрачає непорожність, а z.enum() вимагає саме непорожній кортеж.
// Об'єкт вище — літерал, тож звуження безпечне.
const apiErrorCodeValues = Object.values(API_ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]]

export const apiErrorCodeSchema = z.enum(apiErrorCodeValues)

/**
 * Єдина форма відповіді-помилки для всього API. `apps/web` розбирає нею будь-який
 * неуспішний відгук, `apps/api` нею ж формує вихід глобального фільтра винятків.
 */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
})

export type ApiError = z.infer<typeof apiErrorSchema>
