import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import { API_ERROR_CODES, API_PREFIX, apiErrorSchema } from '@bookswap/shared'
import { BATCH_BOOK_LOOKUP_PROVIDER } from '../src/catalog/lookup/batch-book-lookup-provider'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'
import { csvContent, importUrl, toBase64 } from './helpers/library-import'
import { uniqueIsbn13 } from './helpers/unique-isbn'
import { FakeBatchLookupProvider } from './lookup/fake-batch-lookup-provider'

/**
 * §4: a CSV preview has a throttle of its own — 5 per minute by default.
 *
 * It cannot share the `lookup` bucket: one preview may ask about 200 ISBNs at
 * once, so counting it there would either starve the add-book wizard or let a
 * single file spend the whole minute's allowance. Limit and window are read
 * lazily (`common/rate-limit.config.ts`), so setting them before the app comes
 * up works exactly as `.env` does in production.
 */
describe('Rate limiting на CSV-імпорт (e2e)', () => {
  let app: INestApplication<App>
  let cookie: string
  let importId: string
  let rowVersion: string
  const fake = new FakeBatchLookupProvider()
  /** Previews accepted in this file — the bucket is per IP, so it is one budget. */
  let accepted = 0

  const LIMIT = 3
  const WINDOW_MS = 60_000

  async function register(prefix: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: uniqueEmail(prefix), password: VALID_PASSWORD, displayName: 'Лімітник' })
      .expect(201)

    return sessionCookie(response.headers)
  }

  beforeAll(async () => {
    process.env.LIBRARY_IMPORT_PREVIEW_RATE_LIMIT = String(LIMIT)
    process.env.LIBRARY_IMPORT_RATE_WINDOW_MS = String(WINDOW_MS)

    app = await createTestApp({
      withRateLimit: true,
      configure: (builder) => {
        builder.overrideProvider(BATCH_BOOK_LOOKUP_PROVIDER).useValue(fake)
      },
    })
    cookie = await register('import-limit')

    // The draft under test is created BEFORE the budget is spent: once the
    // limit is reached no preview would succeed, and the PATCH case below still
    // needs something to patch.
    const draft = await send(cookie).expect(201)

    accepted += 1
    const body = draft.body as { import: { id: string }; rows: { rowVersion: string }[] }

    importId = body.import.id
    rowVersion = body.rows[0]?.rowVersion ?? ''
  })

  afterAll(async () => {
    delete process.env.LIBRARY_IMPORT_PREVIEW_RATE_LIMIT
    delete process.env.LIBRARY_IMPORT_RATE_WINDOW_MS
    await app.close()
  })

  function send(sessionCookieValue: string): request.Test {
    return request(app.getHttpServer())
      .post(importUrl('/preview'))
      .set('Cookie', sessionCookieValue)
      .send({
        contentBase64: toBase64(
          csvContent([{ isbn13: uniqueIsbn13('library-import-rate-limit') }]),
        ),
      })
  }

  it('після вичерпання ліміту preview відповідає 429 з машиночитним code', async () => {
    let blocked: request.Response | undefined

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      const response = await send(cookie)

      if (response.status === 429) {
        blocked = response
        break
      }

      expect(response.status).toBe(201)
      accepted += 1
    }

    expect(accepted).toBe(LIMIT)
    expect(apiErrorSchema.parse(blocked?.body).code).toBe(API_ERROR_CODES.TOO_MANY_REQUESTS)
  })

  /**
   * The PATCH limit is a separate, much larger one in the same bucket: it can
   * also reach a provider, but only ever for one ISBN. A spent preview
   * allowance must not lock the person out of fixing the draft they already
   * have.
   */
  it('вичерпаний ліміт preview не блокує редагування наявної чернетки', async () => {
    await send(cookie).expect(429)

    await request(app.getHttpServer())
      .patch(importUrl(`/${importId}/rows/1`))
      .set('Cookie', cookie)
      .send({ action: 'SKIP', expectedRowVersion: rowVersion })
      .expect(200)
  })
})
