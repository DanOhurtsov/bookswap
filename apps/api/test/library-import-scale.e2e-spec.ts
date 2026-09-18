import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import request from 'supertest'
import type { App } from 'supertest/types'
import { API_PREFIX, type LibraryImportCsvCells } from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { PrismaService } from '../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { countingPrisma, recordQueries, type QueryLog } from './helpers/counting-prisma'
import { patchRow, preview, versionOf } from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * Stage 8f-2, DoD: "the query count does not grow linearly with rows".
 *
 * Proved by measurement, not by reading the code: every statement the request
 * issues is recorded through a transparent proxy over the injected
 * `PrismaService`, and the list from a small file has to equal the list from a
 * large one — same statements, same number of them.
 *
 * The external side is bounded here at one call to the batch port per preview.
 * That the port itself splits into 50-bibkey requests is pinned separately, in
 * `batched-book-lookup-provider.spec.ts`, where the real provider runs.
 */
describe('CSV import at scale (e2e)', () => {
  let app: INestApplication<App>
  let cookie: string
  const fake = new FakeBatchLookupProvider()
  const log: QueryLog = []

  beforeAll(async () => {
    app = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
        builder.overrideProvider(PrismaService).useFactory({
          factory: (config: ConfigService) => countingPrisma(new PrismaService(config), log),
          inject: [ConfigService],
        })
      },
    })

    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({
        email: uniqueEmail('import-scale'),
        password: VALID_PASSWORD,
        displayName: 'Масштаб',
      })
      .expect(201)

    cookie = sessionCookie(response.headers)

    await request(app.getHttpServer())
      .post(`${API_PREFIX}/works`)
      .set('Cookie', cookie)
      .send({
        title: `${SHARED_WORD} еталон`,
        origLang: 'en',
        authors: [{ name: 'Еталонний автор' }],
      })
      .expect(201)
  })

  afterEach(() => {
    fake.clear()
  })

  afterAll(async () => {
    await app.close()
  })

  /** A base word unique to this file: candidate search reads the whole catalog. */
  const SHARED_WORD = 'Позаобрійність'

  let markers = 0

  const marker = (): string => {
    markers += 1

    return `${Math.random().toString(36).slice(2, 8)}${markers.toString(36)}`
  }

  /**
   * Rows with DISTINCT titles that all rank against one existing work.
   *
   * Distinct so candidate search cannot collapse them into a single term, and
   * all matching so hydration really runs — otherwise the counts below would
   * pass by doing nothing at all.
   */
  function rows(count: number): Partial<LibraryImportCsvCells>[] {
    return Array.from({ length: count }, () => ({
      isbn13: uniqueIsbn13('library-import-scale'),
      title: `${SHARED_WORD} ${marker()}`,
      authors: `Автор ${marker()}`,
      orig_lang: 'en',
      edition_lang: 'en',
    }))
  }

  function tally(statements: QueryLog): Record<string, number> {
    return statements.reduce<Record<string, number>>((counts, statement) => {
      counts[statement] = (counts[statement] ?? 0) + 1

      return counts
    }, {})
  }

  it('preview малого й великого файла робить ті самі запити в тій самій кількості', async () => {
    const small = await recordQueries(log, async () => {
      await preview(app, cookie, rows(3))
    })
    const smallBatches = fake.batches.length

    fake.clear()

    const large = await recordQueries(log, async () => {
      await preview(app, cookie, rows(60))
    })

    expect(tally(large)).toEqual(tally(small))
    // Not a coincidence of an empty log: resolution really did run, candidates
    // included.
    expect(small).toContain('edition.findMany')
    expect(small).toContain('externalBookLookup.findMany')
    expect(small).toContain('work.findMany')

    // One call to the provider port for the whole file, twenty times the rows.
    expect(smallBatches).toBe(1)
    expect(fake.batches).toHaveLength(1)
    expect(fake.batches[0]).toHaveLength(60)
  })

  it('локальні видання, кеш, кандидати й гідратація — по одному запиту на файл', async () => {
    const statements = await recordQueries(log, async () => {
      await preview(app, cookie, rows(40))
    })
    const counts = tally(statements)

    // Twice, not once, and deliberately so: the pass before the transaction
    // works out which ISBNs still need the outside world and fills the cache,
    // then resolution inside the transaction reads both tables again from its
    // own snapshot. Two constant statements each — not two per row, which is
    // what the claim is about.
    expect(counts['edition.findMany']).toBe(2)
    expect(counts['externalBookLookup.findMany']).toBe(2)
    // Candidate ranking and its hydration: one statement each, for all rows.
    expect(counts['work.findMany']).toBe(1)
    expect(counts['libraryImportRow.createMany']).toBe(1)
  })

  it('PATCH великої чернетки теж не росте по запиту на рядок', async () => {
    const draft = await preview(app, cookie, rows(40))

    fake.clear()

    const statements = await recordQueries(log, async () => {
      await patchRow(
        app,
        cookie,
        { importId: draft.import.id, rowNumber: 1 },
        { action: 'EDIT', expectedRowVersion: versionOf(draft, 1), cells: { quantity: '2' } },
      )
    })
    const counts = tally(statements)

    expect(counts['edition.findMany']).toBe(2)
    expect(counts['work.findMany']).toBe(1)
    expect(counts['libraryImportRow.createMany']).toBe(1)
    expect(counts['libraryImportRow.deleteMany']).toBe(1)
    // The row's own ISBN is the only thing the outside world is asked about.
    expect(fake.batches.flat().length).toBeLessThanOrEqual(1)
  })
})
