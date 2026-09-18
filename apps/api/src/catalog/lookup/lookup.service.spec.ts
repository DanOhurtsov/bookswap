import type { BookLookupResult } from '@bookswap/shared'
import type { HttpException } from '@nestjs/common'
import type { PrismaService } from '../../prisma/prisma.service'
import type { BatchBookLookupProvider } from './batch-book-lookup-provider'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import { LookupService } from './lookup.service'

/** `ApiException` несе `code` у тілі відповіді (`getResponse()`), не як власну властивість. */
async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    throw new Error('очікувався виняток')
  } catch (error) {
    return (error as HttpException).getResponse()
  }
}

/**
 * Cleanup Stage 7, аудит: `packages/shared/src/contracts/lookup.ts` звузив
 * `language` з довільного `string` до `languageCodeSchema` (ISO 639-1).
 * Ці тести — доказ compatibility саме на межі, де звуження могло б щось
 * зламати: читання вже закешованого рядка `ExternalBookLookup.payload`.
 *
 * Доведено окремо (git-історія `open-library-lookup-provider.ts` від
 * комітів, що передують цьому cleanup): єдиний виробник `payload` у
 * продакшені — `OpenLibraryLookupProvider`, і жодна його версія ніколи не
 * писала ключ `language` у повернений об'єкт узагалі — не те що невалідний,
 * а взагалі відсутній. Тест «legacy-payload без language» нижче фіксує це
 * структурно: legacy-форма парситься без утрат.
 *
 * `readCache` водночас навмисно стійкий і до гіпотетичного зіпсованого рядка
 * (ручне втручання в БД, майбутній провайдер, що напише щось не те) —
 * `safeParse`, не `.catch({})`: рядок, що не проходить схему, трактується як
 * cache miss, а не 500 і не мовчки підмінене значення.
 */
describe('LookupService', () => {
  interface Row {
    isbn: string
    payload: unknown
    fetchedAt: Date
  }

  function fakePrisma(row: Row | null): {
    prisma: PrismaService
    findUnique: jest.Mock
    upsert: jest.Mock
  } {
    const findUnique = jest.fn().mockResolvedValue(row)
    const upsert = jest.fn().mockResolvedValue(undefined)

    const prisma = {
      externalBookLookup: { findUnique, upsert },
    } as unknown as PrismaService

    return { prisma, findUnique, upsert }
  }

  function fakeProvider(result: BookLookupResult | Error): {
    provider: BookLookupProvider
    lookup: jest.Mock
  } {
    const lookup = jest
      .fn()
      .mockImplementation(() =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      )

    return { provider: { lookup }, lookup }
  }

  /**
   * Stage 8f-2: the single-ISBN path must never reach the batch port. Every
   * case below passes this, so a call that did would fail loudly here instead
   * of silently going out to a provider.
   */
  function unusedBatchProvider(): BatchBookLookupProvider {
    return {
      lookupMany: () => {
        throw new Error('Одиночний lookup не має торкатися batch-провайдера')
      },
    }
  }

  const ISBN = '9783161484100'

  it('cache miss (рядка немає) — питає провайдера й записує кеш', async () => {
    const { prisma, upsert } = fakePrisma(null)
    const fresh: BookLookupResult = { title: 'Свіже' }
    const { provider, lookup } = fakeProvider(fresh)

    const service = new LookupService(prisma, provider, unusedBatchProvider())
    const result = await service.lookup(ISBN)

    expect(result).toEqual(fresh)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isbn: ISBN }, create: { isbn: ISBN, payload: fresh } }),
    )
  })

  it('cache hit у межах TTL — провайдера НЕ викликає', async () => {
    const cached: BookLookupResult = { title: 'Кешоване', language: 'en' }
    const { prisma } = fakePrisma({ isbn: ISBN, payload: cached, fetchedAt: new Date() })
    const { provider, lookup } = fakeProvider({ title: 'мало б не використатись' })

    const service = new LookupService(prisma, provider, unusedBatchProvider())
    const result = await service.lookup(ISBN)

    expect(result).toEqual(cached)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('прострочений кеш (TTL вичерпано) — cache miss, іде до провайдера', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000) // 31 день, TTL = 30
    const { prisma } = fakePrisma({
      isbn: ISBN,
      payload: { title: 'Застаріле' },
      fetchedAt: old,
    })
    const fresh: BookLookupResult = { title: 'Нове' }
    const { provider, lookup } = fakeProvider(fresh)

    const service = new LookupService(prisma, provider, unusedBatchProvider())
    const result = await service.lookup(ISBN)

    expect(result).toEqual(fresh)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('свіжий негативний кеш повертає 404 без повторного виклику провайдерів', async () => {
    const { prisma } = fakePrisma({
      isbn: ISBN,
      payload: { notFound: true },
      fetchedAt: new Date(),
    })
    const { provider, lookup } = fakeProvider({ title: 'не мало б використатись' })

    const service = new LookupService(prisma, provider, unusedBatchProvider())

    await expect(codeOf(service.lookup(ISBN))).resolves.toMatchObject({
      code: 'CATALOG_LOOKUP_NOT_FOUND',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('прострочений негативний кеш знову запускає провайдерів', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60_000)
    const { prisma } = fakePrisma({ isbn: ISBN, payload: { notFound: true }, fetchedAt: old })
    const fresh: BookLookupResult = { title: 'Тепер знайдено' }
    const { provider, lookup } = fakeProvider(fresh)

    const service = new LookupService(prisma, provider, unusedBatchProvider())

    await expect(service.lookup(ISBN)).resolves.toEqual(fresh)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  describe('compatibility: звуження language до languageCodeSchema', () => {
    it('legacy payload БЕЗ ключа language (форма до Stage 7, єдина, яку колись писав провайдер) парситься без утрат', async () => {
      // Точна форма, яку повертав OpenLibraryLookupProvider до нормалізації
      // мови: language там не було в принципі (не undefined — ключа нема).
      const legacyPayload = {
        title: 'Шантарам',
        authors: ['Ґреґорі Девід Робертс'],
        publishedYear: 2003,
        publisher: 'КСД',
        coverUrl: 'https://example.com/cover.jpg',
        externalId: 'OL123456M',
      }
      const { prisma } = fakePrisma({ isbn: ISBN, payload: legacyPayload, fetchedAt: new Date() })
      const { provider, lookup } = fakeProvider({ title: 'не мало б викликатись' })

      const service = new LookupService(prisma, provider, unusedBatchProvider())
      const result = await service.lookup(ISBN)

      expect(result).toEqual(legacyPayload)
      expect(result).not.toHaveProperty('language')
      expect(lookup).not.toHaveBeenCalled()
    })

    it('гіпотетично зіпсований рядок (language не ISO 639-1) — cache miss, а не 500 і не мовчки підмінене значення', async () => {
      const corrupted = { title: 'Зіпсоване', language: 'not-a-real-code' }
      const { prisma, upsert } = fakePrisma({
        isbn: ISBN,
        payload: corrupted,
        fetchedAt: new Date(),
      })
      const fresh: BookLookupResult = { title: 'Перезаписане', language: 'en' }
      const { provider, lookup } = fakeProvider(fresh)

      const service = new LookupService(prisma, provider, unusedBatchProvider())
      const result = await service.lookup(ISBN)

      // Не впало з винятком парсингу, не повернуло зіпсоване значення як є —
      // пішло до провайдера й самозцілило кеш свіжим валідним записом.
      expect(result).toEqual(fresh)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { isbn: ISBN, payload: fresh } }),
      )
    })

    it('зіпсований рядок зі структурно неправильним типом (payload — не об’єкт) — теж cache miss, не виняток', async () => {
      const { prisma } = fakePrisma({ isbn: ISBN, payload: 'просто рядок', fetchedAt: new Date() })
      const fresh: BookLookupResult = { title: 'Нове' }
      const { provider, lookup } = fakeProvider(fresh)

      const service = new LookupService(prisma, provider, unusedBatchProvider())

      await expect(service.lookup(ISBN)).resolves.toEqual(fresh)
      expect(lookup).toHaveBeenCalledTimes(1)
    })
  })

  describe('помилки провайдера при cache miss', () => {
    it('провайдер не знає ISBN (undefined) — CATALOG_LOOKUP_NOT_FOUND і короткий негативний кеш', async () => {
      const { prisma, upsert } = fakePrisma(null)
      const lookup = jest.fn().mockResolvedValue(undefined)
      const provider: BookLookupProvider = { lookup }

      const service = new LookupService(prisma, provider, unusedBatchProvider())

      await expect(codeOf(service.lookup(ISBN))).resolves.toMatchObject({
        code: 'CATALOG_LOOKUP_NOT_FOUND',
      })
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isbn: ISBN },
          create: { isbn: ISBN, payload: { notFound: true } },
        }),
      )
    })

    it('провайдер кидає помилку — CATALOG_LOOKUP_PROVIDER_ERROR, кеш не пишеться', async () => {
      const { prisma, upsert } = fakePrisma(null)
      const { provider } = fakeProvider(new BookLookupProviderError('глюк'))

      const service = new LookupService(prisma, provider, unusedBatchProvider())

      await expect(codeOf(service.lookup(ISBN))).resolves.toMatchObject({
        code: 'CATALOG_LOOKUP_PROVIDER_ERROR',
      })
      expect(upsert).not.toHaveBeenCalled()
    })
  })
})

/**
 * Stage 8f-2: what the batch path is allowed to remember.
 *
 * The negative cache is a claim — "no provider knows this ISBN" — and it lasts a
 * day. An ISBN whose search never finished has not earned that claim, and
 * writing it would make one broken record mean "no such book" to the add-book
 * wizard too.
 */
describe('LookupService.lookupMany — що потрапляє в кеш', () => {
  function fakeBatchPrisma(): {
    prisma: PrismaService
    findMany: jest.Mock
    executeRaw: jest.Mock
  } {
    const findMany = jest.fn().mockResolvedValue([])
    const executeRaw = jest.fn().mockResolvedValue(1)

    const prisma = {
      externalBookLookup: { findMany },
      $executeRaw: executeRaw,
    } as unknown as PrismaService

    return { prisma, findMany, executeRaw }
  }

  function batchProvider(outcome: {
    found?: [string, BookLookupResult][]
    notFound?: string[]
    unavailable?: [string, 'PROVIDER_ERROR' | 'TIMEOUT' | 'BUDGET_EXHAUSTED'][]
  }): BatchBookLookupProvider {
    return {
      lookupMany: () =>
        Promise.resolve({
          found: new Map(outcome.found ?? []),
          notFound: new Set(outcome.notFound ?? []),
          unavailable: new Map(outcome.unavailable ?? []),
        }),
    }
  }

  const single = { lookup: () => Promise.resolve(undefined) }

  it('успіх і завершене «не знайдено» кешуються, незавершений пошук — ні', async () => {
    const { prisma, executeRaw } = fakeBatchPrisma()
    const service = new LookupService(
      prisma,
      single,
      batchProvider({
        found: [['9780306406157', { title: 'Є' }]],
        notFound: ['9780262033848'],
        unavailable: [['9783161484100', 'PROVIDER_ERROR']],
      }),
    )

    const outcomes = await service.lookupMany(['9780306406157', '9780262033848', '9783161484100'])

    expect(outcomes.get('9783161484100')).toEqual({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
    })
    expect(executeRaw).toHaveBeenCalledTimes(1)

    const written = JSON.stringify(executeRaw.mock.calls[0])

    expect(written).toContain('9780306406157')
    expect(written).toContain('9780262033848')
    // The one whose search never finished is absent from the write.
    expect(written).not.toContain('9783161484100')
  })

  it('нічого завершеного — жодного запису в кеш', async () => {
    const { prisma, executeRaw } = fakeBatchPrisma()
    const service = new LookupService(
      prisma,
      single,
      batchProvider({ unavailable: [['9780306406157', 'TIMEOUT']] }),
    )

    await service.lookupMany(['9780306406157'])

    expect(executeRaw).not.toHaveBeenCalled()
  })
})
