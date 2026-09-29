import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { GuestContactRetentionCleanupService } from '../external-borrowers/guest-contact-retention-cleanup.service'
import { GuestContactRetentionCliModule } from './guest-contact-retention-cli.module'
import type { RetentionCleanupSummary } from '../external-borrowers/guest-contact-retention-cleanup.service'

/**
 * Stage 10 (10h, Q1 §0.9 execution plan): retention-чистка гостьових контактів (D3).
 *
 * Виконавець — ЗОВНІШНІЙ планувальник поза процесом API (Q1: варіант (a), інтервальний сервіс за
 * зразком `SessionCleanupService`, явно НЕ обрано для цієї чистки). Запуск (з кореня репозиторію):
 *
 *   pnpm --filter @bookswap/api run retention:guest-contacts
 *
 * Призначено для ЩОДЕННОГО запуску зовнішнім scheduler-ом (cron, Kubernetes CronJob тощо —
 * платформа розгортання API ще не обрана, це рішення НЕ стверджує, що такий scheduler уже
 * налаштований чи запущений десь), а також для НЕГАЙНОГО ручного запуску одразу після кожного
 * відновлення з backup (§6.11 execution plan, гранична ситуація 6: restore повертає стерті alias
 * — наступний прохід прибирає їх знову).
 *
 * Ідемпотентна: повторний запуск того самого дня — безпечний no-op для вже опрацьованих контактів
 * (RET6). Не виводить alias, id контакту чи інший PII — лише кількості на успіху, і, на помилці,
 * лише КЛАС помилки (ніколи `.message`/`.stack`/SQL/параметри запиту/`DATABASE_URL`).
 *
 * **Shutdown policy (затверджено PO).** `app.close()` має бюджет 5000 мс:
 *   - завершився вчасно й успішно → процес виходить звичайним шляхом (`process.exitCode`, без
 *     примусового `process.exit()` — Node сам завершується, щойно порожній event loop);
 *   - відхилився АБО не завершився за бюджет → лише одне безпечне технічне повідомлення в stderr
 *     і ПРИМУСОВЕ завершення з кодом 1 (`process.exit(1)`), незалежно від того, чи сама чистка
 *     (`run()`) до цього встигла відпрацювати успішно. Це єдине місце в цьому файлі, де взагалі
 *     викликається `process.exit()`.
 *
 * Коди виходу: `0` — увесь прохід (контекст, чистка, закриття) завершився успішно; `1` — збій на
 * БУДЬ-ЯКОМУ з трьох етапів (створення Nest application context, `run()`, закриття). Жодна помилка
 * в одній пачці `run()` не валить процес мовчки — пачкові транзакції гарантують, що вже опрацьовані
 * пачки лишаються опрацьованими, без напівстертих даних у пачці, що впала.
 */
function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Клас-код Prisma (`PrismaClientKnownRequestError.code` тощо) — стала, задокументована мала
 * множина технічних кодів (`P1001`, `P2025`, …), не дані самого запиту. Формат перевіряється явно:
 * довільний `.code`, який трапився на іншому типі помилки (не обов'язково від Prisma), не
 * друкується — лише те, що структурно виглядає як цей конкретний, безпечний формат.
 */
const SAFE_PRISMA_CODE_PATTERN = /^P\d{4}$/

/**
 * Безпечний операційний сигнал збою — БЕЗ `.message`/`.stack`. Prisma-помилки часто вкладають у
 * `.message` текст SQL-запиту й/або значення параметрів (у цьому CLI це потенційно alias чи
 * contactId) — runbook прямо обіцяє відсутність PII у виводі, тож сюди йде лише клас помилки й,
 * якщо він проходить `SAFE_PRISMA_CODE_PATTERN`, класифікаційний код. Повний стек/повідомлення для
 * діагностики лишається в реальних, окремо керованих логах інфраструктури БД/оркестрації, не тут.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'невідома помилка (не Error)'

  const code = (error as { code?: unknown }).code

  return typeof code === 'string' && SAFE_PRISMA_CODE_PATTERN.test(code)
    ? `${error.constructor.name} (код ${code})`
    : error.constructor.name
}

export interface CloseableApp {
  close: () => Promise<void>
}

export type CloseResult =
  { ok: true } | { ok: false; reason: 'timeout' } | { ok: false; reason: 'error'; error: unknown }

/**
 * `app.close()` під бюджетом. `Promise.race` коректно ловить обидва шляхи збою: якщо `close()`
 * відхиляється РАНІШЕ, ніж спрацьовує таймер, `race` відхиляється тим самим — перехоплюється тут;
 * якщо таймер спрацьовує першим, `race` вирішується як `{ reason: 'timeout' }`. Таймер `.unref()`-
 * иться, щоб сам по собі не тримав процес живим довше за потрібне.
 */
export async function closeWithBudget(app: CloseableApp, budgetMs: number): Promise<CloseResult> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race<CloseResult>([
      app.close().then(() => ({ ok: true })),
      new Promise<CloseResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), budgetMs)
        timer.unref()
      }),
    ])
  } catch (error) {
    return { ok: false, reason: 'error', error }
  } finally {
    clearTimeout(timer)
  }
}

export interface CliIO {
  out: (line: string) => void
  fail: (line: string) => void
  /** Викликається РІВНО тоді, коли закриття відхилилось або не встигло за бюджет — і ніколи інакше. */
  forceExit: (code: number) => void
}

export interface ExecuteDeps<TApp extends CloseableApp> {
  createContext: () => Promise<TApp>
  runCleanup: (app: TApp) => Promise<RetentionCleanupSummary>
  closeBudgetMs: number
}

/**
 * Уся керована логіка одного проходу — без side-effects самого процесу (немає прямого
 * `process.exit`/`process.stdout.write`): і `io`, і залежності інʼєктовані, тож кожен із трьох
 * етапів (контекст/`run()`/закриття) детерміновано тестований без реальної БД/Nest/затримок у
 * реальному часі. `main()` нижче — тонка обв'язка, що підставляє реальні `NestFactory`,
 * `process.std{out,err}.write` і `process.exit`.
 *
 * Повідомлення про успіх друкуються лише ПІСЛЯ підтвердженого успішного закриття (`closeResult.ok
 * === true`) — ніколи раніше: до цього моменту неможливо ствердити, що прохід справді завершився
 * охайно, а не залишив недозакритий стан.
 */
export async function executeCleanupRun<TApp extends CloseableApp>(
  io: CliIO,
  deps: ExecuteDeps<TApp>,
): Promise<number> {
  let app: TApp

  try {
    app = await deps.createContext()
  } catch (error) {
    io.fail('Не вдалося ініціалізувати контекст застосунку')
    io.fail(`Тип помилки: ${describeFailure(error)}`)

    return 1
  }

  let summary: RetentionCleanupSummary | undefined
  let runFailed = false

  try {
    summary = await deps.runCleanup(app)
  } catch (error) {
    runFailed = true
    io.fail('Retention-чистка гостьових контактів не завершилась успішно')
    io.fail(`Тип помилки: ${describeFailure(error)}`)
  }

  const closeResult = await closeWithBudget(app, deps.closeBudgetMs)

  if (!closeResult.ok) {
    if (closeResult.reason === 'timeout') {
      io.fail(
        `Закриття ресурсів не завершилося за ${String(deps.closeBudgetMs)} мс — примусове завершення`,
      )
    } else {
      io.fail('Закриття ресурсів завершилося помилкою — примусове завершення')
      io.fail(`Тип помилки: ${describeFailure(closeResult.error)}`)
    }

    // Єдине місце у всьому проході, де взагалі відбувається примусове завершення: закриття не
    // встигло/не змогло — Node інакше міг би чекати недозакритий хендл нескінченно, попри те що
    // решта проходу вже completed. Код виходу — завжди 1, незалежно від того, чи `run()` до цього
    // встиг відпрацювати успішно (успіх чистки не скасовує збій закриття ресурсів).
    io.forceExit(1)

    return 1
  }

  if (runFailed || summary === undefined) return 1

  io.out(`Перераховано retainUntil: ${String(summary.backfilled)}`)
  io.out(`Видалено гостьових контактів: ${String(summary.deleted)}`)

  return 0
}

const CLOSE_BUDGET_MS = 5_000

async function main(): Promise<void> {
  const exitCode = await executeCleanupRun(
    { out, fail, forceExit: (code) => process.exit(code) },
    {
      // `abortOnError: false` — БЕЗ цього NestJS сам викликає `process.exit(1)` зсередини свого
      // bootstrap-механізму (`ExceptionsZone`, `@nestjs/core/errors/exceptions-zone.js`) на будь-
      // якій фатальній помилці ініціалізації (напр. `validateEnv` кидає на кривому
      // `DATABASE_URL`) — синхронно, до того, як рантайм взагалі поверне контроль цьому
      // `await`/`catch`. Спостережено вручну: без цього прапорця збій контексту виходить мовчки,
      // з exit 1, але без жодного контрольованого повідомлення — рівно те, чого просить уникнути
      // ця задача («оброблялися контрольовано» для всіх трьох етапів). З прапорцем — Nest замість
      // цього віддає звичайний rejected promise, який `executeCleanupRun` ловить сам.
      createContext: () =>
        NestFactory.createApplicationContext(GuestContactRetentionCliModule, {
          logger: false,
          abortOnError: false,
        }),
      runCleanup: (app) => app.get(GuestContactRetentionCleanupService).run(),
      closeBudgetMs: CLOSE_BUDGET_MS,
    },
  )

  // Немає безумовного `process.exit()` тут: коли закриття відбулось успішно (навіть якщо сам
  // `run()` не вдався), процес виходить звичайним шляхом на порожньому event loop — лише код
  // виходу виставляється явно. Примусове завершення лишається виключно всередині
  // `executeCleanupRun` (`io.forceExit`), і тільки для збою/таймауту самого закриття.
  process.exitCode = exitCode
}

// `guest-contact-retention-cleanup.spec.ts` імпортує `describeFailure`/`closeWithBudget`/
// `executeCleanupRun` з цього самого файлу для юніт-тестів — без цієї охорони `main()` (реальний
// `NestFactory`, реальні env) виконався б як побічний ефект самого імпорту, а не лише при запуску
// файлу як CLI-скрипта.
if (require.main === module) {
  void main()
}
