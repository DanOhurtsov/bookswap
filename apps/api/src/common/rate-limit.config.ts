import type { ExecutionContext } from '@nestjs/common'

/**
 * `@Throttle` фіксує своє значення в момент декорування контролера — а це
 * відбувається до того, як `ConfigModule` встигає завантажити кореневий `.env`:
 * `app.module.ts` підвантажує (через `import`) контролери, зокрема
 * `CatalogController`, раніше, ніж викликає `ConfigModule.forRoot()`. Пряме
 * читання `process.env` тут повернуло б undefined навіть за наявного `.env`.
 *
 * Функція замість числа читається лінькво — `@nestjs/throttler` викликає її
 * при кожному запиті (`Resolvable<number>`), тобто вже після того, як
 * `ConfigModule` гарантовано завантажив і провалідував оточення.
 */
function fromEnv(key: string, fallback: number): (context: ExecutionContext) => number {
  return () => {
    const raw = process.env[key]
    if (raw === undefined || raw.trim() === '') return fallback

    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
  }
}

/**
 * §11, R2: ліміт на створення Work/Translation/Edition — антиспам спільного
 * каталогу. Сховище лічильника — в пам'яті процесу (див. README): не переживає
 * рестарт і не ділиться між інстансами.
 */
export const CATALOG_WRITE_RATE_LIMIT = fromEnv('CATALOG_WRITE_RATE_LIMIT', 30)
export const CATALOG_WRITE_RATE_WINDOW_MS = fromEnv('CATALOG_WRITE_RATE_WINDOW_MS', 60 * 60_000)

/**
 * docs/plan/stage-7.md, 7b + R2: окремий бакет для `GET /catalog/lookup`, а не
 * той самий 'auth', яким обмежені write-ендпоінти каталогу.
 *
 * Природа захисту інша: write-ліміт стримує засмічення СПІЛЬНОЇ бази
 * дублікатами (антиспам на запис), а цей — власний зовнішній виклик до Open
 * Library на КОЖЕН cache miss. Попадання в кеш (R3) економить зовнішній
 * виклик, але саме тому рахується цим лімітом так само, як і miss: інакше він
 * захищав би не власника квоти (наш процес перед Open Library), а лише
 * випадок «щойно спитали те саме» — а зловмисник із набором різних ISBN'ів
 * пройшов би без обмежень.
 */
export const CATALOG_LOOKUP_RATE_LIMIT = fromEnv('CATALOG_LOOKUP_RATE_LIMIT', 20)
export const CATALOG_LOOKUP_RATE_WINDOW_MS = fromEnv('CATALOG_LOOKUP_RATE_WINDOW_MS', 60_000)

/**
 * §4, Stage 8f-2: a CSV preview is throttled on its own — 5 per minute per
 * authenticated client.
 *
 * Neither the catalog write bucket nor the lookup one fits. A preview can reach
 * Open Library with up to 200 ISBNs at once, so counting it against the
 * single-lookup bucket would either starve the wizard or let one file spend the
 * whole minute's allowance. The row PATCH shares the bucket with a much higher
 * limit: it can also call a provider (a retry), but only ever for one ISBN.
 */
export const LIBRARY_IMPORT_PREVIEW_RATE_LIMIT = fromEnv('LIBRARY_IMPORT_PREVIEW_RATE_LIMIT', 5)
export const LIBRARY_IMPORT_PATCH_RATE_LIMIT = fromEnv('LIBRARY_IMPORT_PATCH_RATE_LIMIT', 120)
export const LIBRARY_IMPORT_RATE_WINDOW_MS = fromEnv('LIBRARY_IMPORT_RATE_WINDOW_MS', 60_000)
