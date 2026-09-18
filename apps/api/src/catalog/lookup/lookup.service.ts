import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { API_ERROR_CODES, bookLookupResultSchema, type BookLookupResult } from '@bookswap/shared'
import { ApiException } from '../../common/api.exception'
import { Prisma } from '../../generated/prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import {
  BATCH_BOOK_LOOKUP_PROVIDER,
  type BatchBookLookupProvider,
  type BatchLookupUnavailableReason,
} from './batch-book-lookup-provider'
import {
  BOOK_LOOKUP_PROVIDER,
  BookLookupProviderError,
  type BookLookupProvider,
} from './book-lookup-provider'
import { lookupCacheTtlMs, lookupNegativeCacheTtlMs, lookupTimeoutMs } from './lookup.config'

/** Внутрішній маркер: race програно таймауту, а не провайдеру. */
class LookupTimeoutError extends Error {}

const NEGATIVE_CACHE_PAYLOAD = { notFound: true } as const

type CacheReadResult =
  { kind: 'hit'; result: BookLookupResult } | { kind: 'not-found' } | { kind: 'miss' }

/** Stage 8f-2: reading the cache works from a transaction client too. */
type CacheClient = Pick<PrismaService, 'externalBookLookup'>

/** Stage 8f-2: what one ISBN of a batch ended up as, cache and providers together. */
export type BatchLookupRowOutcome =
  | { kind: 'found'; result: BookLookupResult }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; reason: BatchLookupUnavailableReason }

function isNegativeCachePayload(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).notFound === true
  )
}

/**
 * §6.3, крок 1 і R3: кеш + оркестрація зовнішнього провайдера.
 *
 * Валідація формату ISBN сюди не потрапляє: за DoD 7b невалідний ISBN мусить
 * дати 400 ДО будь-якого зовнішнього виклику, а це вже робить
 * `LookupQueryDto` (`class-validator`) на вході в контролер.
 */
@Injectable()
export class LookupService {
  private readonly logger = new Logger(LookupService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BOOK_LOOKUP_PROVIDER) private readonly provider: BookLookupProvider,
    @Inject(BATCH_BOOK_LOOKUP_PROVIDER) private readonly batchProvider: BatchBookLookupProvider,
  ) {}

  /**
   * Stage 8f-2, R7: the cache-aware batch path behind a CSV preview.
   *
   * The cache contract is the single-lookup one, unchanged — same TTLs, same
   * "a row that no longer parses is a miss, not a 500", same negative entries —
   * only read and written in bulk instead of one row at a time. That matters
   * beyond speed: a cached negative here and a cached negative in the wizard
   * have to mean the same thing, or the same ISBN would answer differently
   * depending on which screen asked.
   *
   * Never call this inside a transaction: it makes external HTTP requests.
   */
  async lookupMany(isbns: readonly string[]): Promise<Map<string, BatchLookupRowOutcome>> {
    const unique = [...new Set(isbns)]
    const outcomes = new Map<string, BatchLookupRowOutcome>()

    if (unique.length === 0) return outcomes

    const cached = await this.readCachedMany(unique)
    const misses: string[] = []

    for (const isbn of unique) {
      const entry = cached.get(isbn)

      if (entry === undefined) misses.push(isbn)
      else outcomes.set(isbn, entry)
    }

    if (misses.length === 0) return outcomes

    const controller = new AbortController()
    const fetched = await this.batchProvider.lookupMany(misses, controller.signal)

    for (const [isbn, result] of fetched.found) outcomes.set(isbn, { kind: 'found', result })
    for (const isbn of fetched.notFound) outcomes.set(isbn, { kind: 'not-found' })
    for (const [isbn, reason] of fetched.unavailable) {
      outcomes.set(isbn, { kind: 'unavailable', reason })
    }

    // Only settled answers are cached. An ISBN we could not finish asking about
    // must stay a miss, or one slow afternoon would be remembered for a day as
    // "no such book".
    await this.writeCacheMany(fetched.found, fetched.notFound)

    return outcomes
  }

  async lookup(isbn: string): Promise<BookLookupResult> {
    const cached = await this.readCache(isbn)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'not-found') this.throwNotFound(isbn)

    const result = await this.fetchFromProvider(isbn)

    if (result === undefined) {
      await this.writeNegativeCache(isbn)
      this.throwNotFound(isbn)
    }

    await this.writeCache(isbn, result)

    return result
  }

  /**
   * R3: попадання в кеш не витрачає ліміт зовнішнього провайдера.
   *
   * `safeParse`, не `parse`: рядок у `ExternalBookLookup` пережив запис однієї
   * версії схеми — контракт (наприклад, звуження `language` до
   * `languageCodeSchema`, cleanup Stage 7) може зміцніти пізніше. Історія
   * цього конкретного поля доводить, що жоден наявний виробник payload
   * (`OpenLibraryLookupProvider`) ніколи не писав невалідного значення (див.
   * `lookup.service.spec.ts`), але саме сховище — не той рівень, де варто
   * покладатись на це назавжди: рядок, що не проходить актуальну схему,
   * трактується як cache miss — сервіс іде до провайдера й перезаписує кеш
   * свіжим, валідним значенням, а не валить увесь запит 500-ю чи мовчки
   * підміняє поле (`.catch({})` тут навмисно не використовується — саме це
   * ховало б проблему, а не лікувало).
   */
  private async readCache(isbn: string): Promise<CacheReadResult> {
    const row = await this.prisma.externalBookLookup.findUnique({ where: { isbn } })

    if (row === null) return { kind: 'miss' }

    return this.classifyCacheRow(isbn, row)
  }

  /** The TTL and payload rules above, applied to one already-read row. */
  private classifyCacheRow(
    isbn: string,
    row: { payload: unknown; fetchedAt: Date },
  ): CacheReadResult {
    const age = Date.now() - row.fetchedAt.getTime()

    if (isNegativeCachePayload(row.payload)) {
      return age <= lookupNegativeCacheTtlMs() ? { kind: 'not-found' } : { kind: 'miss' }
    }

    if (age > lookupCacheTtlMs()) return { kind: 'miss' }

    const parsed = bookLookupResultSchema.safeParse(row.payload)

    if (!parsed.success) {
      this.logger.warn(
        `Кешований запис ExternalBookLookup(${isbn}) не пройшов схему — трактую як cache miss`,
      )
      return { kind: 'miss' }
    }

    return { kind: 'hit', result: parsed.data }
  }

  /**
   * Stage 8f-2: the cache for a whole file in one query — the read must not
   * grow by a statement per row.
   *
   * Public and client-parameterised because CSV resolution reads it from inside
   * its transaction, where the draft is being written. That is a read of the
   * cache, never a write and never an external call, so it is safe there; the
   * TTL and payload rules are the single-lookup ones, applied unchanged.
   */
  async readCachedMany(
    isbns: readonly string[],
    client: CacheClient = this.prisma,
  ): Promise<Map<string, BatchLookupRowOutcome>> {
    const cached = await this.readCacheMany(isbns, client)
    const outcomes = new Map<string, BatchLookupRowOutcome>()

    for (const [isbn, entry] of cached) {
      if (entry.kind === 'hit') outcomes.set(isbn, { kind: 'found', result: entry.result })
      if (entry.kind === 'not-found') outcomes.set(isbn, { kind: 'not-found' })
    }

    return outcomes
  }

  private async readCacheMany(
    isbns: readonly string[],
    client: CacheClient = this.prisma,
  ): Promise<Map<string, CacheReadResult>> {
    if (isbns.length === 0) return new Map()

    const rows = await client.externalBookLookup.findMany({
      where: { isbn: { in: [...isbns] } },
    })

    return new Map(rows.map((row) => [row.isbn, this.classifyCacheRow(row.isbn, row)]))
  }

  /**
   * One statement for every new cache entry. Prisma has no batch upsert, and a
   * loop of them would put the per-row growth back exactly where R7 forbids it,
   * so this is the one place the import writes raw SQL.
   */
  private async writeCacheMany(
    found: ReadonlyMap<string, BookLookupResult>,
    notFound: ReadonlySet<string>,
  ): Promise<void> {
    const entries = [
      ...[...found].map(([isbn, payload]) => ({ isbn, payload: JSON.stringify(payload) })),
      ...[...notFound].map((isbn) => ({ isbn, payload: JSON.stringify(NEGATIVE_CACHE_PAYLOAD) })),
    ]

    if (entries.length === 0) return

    const values = Prisma.join(
      entries.map((entry) => Prisma.sql`(${entry.isbn}, ${entry.payload}::jsonb, NOW())`),
    )

    await this.prisma.$executeRaw`
      INSERT INTO "ExternalBookLookup" ("isbn", "payload", "fetchedAt")
      VALUES ${values}
      ON CONFLICT ("isbn")
      DO UPDATE SET "payload" = EXCLUDED."payload", "fetchedAt" = EXCLUDED."fetchedAt"
    `
  }

  private async writeCache(isbn: string, payload: BookLookupResult): Promise<void> {
    await this.prisma.externalBookLookup.upsert({
      where: { isbn },
      create: { isbn, payload },
      update: { payload, fetchedAt: new Date() },
    })
  }

  private async writeNegativeCache(isbn: string): Promise<void> {
    await this.prisma.externalBookLookup.upsert({
      where: { isbn },
      create: { isbn, payload: NEGATIVE_CACHE_PAYLOAD },
      update: { payload: NEGATIVE_CACHE_PAYLOAD, fetchedAt: new Date() },
    })
  }

  private throwNotFound(isbn: string): never {
    throw new ApiException(
      API_ERROR_CODES.CATALOG_LOOKUP_NOT_FOUND,
      `Зовнішні провайдери не знають ISBN ${isbn}`,
      HttpStatus.NOT_FOUND,
    )
  }

  /**
   * Таймаут рахується тут, а не всередині провайдера: незалежно від того, чи
   * реалізація поважає `AbortSignal`, виклик сервісу все одно повертається за
   * `lookupTimeoutMs()`. `signal` передається провайдеру як добра практика —
   * реальний HTTP-провайдер нею скасовує вже непотрібний запит, — але
   * гарантію дає саме `Promise.race`.
   */
  private async fetchFromProvider(isbn: string): Promise<BookLookupResult | undefined> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Порядок важливий: `reject` мусить виграти гонку з `providerCall`,
        // тому таймаут-проміс відхиляється ДО `controller.abort()` — інакше
        // скасування синхронно відхилило б `providerCall` (напр. фейковий
        // провайдер, що слухає `abort`) раніше за сам таймаут, і сервіс
        // помилково доповів би `CATALOG_LOOKUP_PROVIDER_ERROR` замість
        // `CATALOG_LOOKUP_TIMEOUT`.
        reject(new LookupTimeoutError())
        controller.abort()
      }, lookupTimeoutMs())
    })

    const providerCall = this.provider.lookup(isbn, controller.signal)
    // Програна гонка не скасовує проміс провайдера: без цього пізнє
    // відхилення (напр. AbortError від fetch) стало б unhandled rejection.
    void providerCall.catch(() => undefined)

    try {
      return await Promise.race([providerCall, timeout])
    } catch (error) {
      if (error instanceof LookupTimeoutError) {
        throw new ApiException(
          API_ERROR_CODES.CATALOG_LOOKUP_TIMEOUT,
          'Зовнішній провайдер не відповів вчасно',
          HttpStatus.GATEWAY_TIMEOUT,
        )
      }

      const description = error instanceof BookLookupProviderError ? error.message : String(error)

      throw new ApiException(
        API_ERROR_CODES.CATALOG_LOOKUP_PROVIDER_ERROR,
        `Зовнішній провайдер повернув помилку: ${description}`,
        HttpStatus.BAD_GATEWAY,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
