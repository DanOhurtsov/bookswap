import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_ERROR_CODES,
  apiErrorSchema,
  editionResponseSchema,
  workDetailResponseSchema,
  type EditionTextKind,
} from '@bookswap/shared'
import { WORK_MERGE_ERROR_CODES, WorkMergeError } from '../src/catalog/merge/merge-errors'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { beginRequest, deferred, waitForBlockedBackend } from './concurrency.helpers'
import { registerAccount, url } from './loan.helpers'

/**
 * Мова й тип тексту видання (docs/plan/fast-book-add.md, ред. 2, §1, QA10): записи несуть явні значення,
 * невідомі дані читаються як невідомі, каскади від зміни мови перекладу й оригіналу й злиття не гублять і
 * не підміняють відому мову, а єдиний порядок блокувань `Work → Translation → Edition` тримає все це
 * узгодженим під конкуренцією. Легасі-рядки до backfill покриває `fast-add-text-migration.db-spec.ts`.
 */
/** Чекає, поки якесь з'єднання блокується саме на блокуванні, яке тримає `pid` (а не будь-яке інше). */
async function waitUntilBlockedBy(
  prisma: PrismaService,
  pid: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
    `

    if (Number(rows[0]?.count ?? 0n) >= 1) return

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(
    `Жодне з'єднання не заблоковане транзакцією ${String(pid)} за ${String(timeoutMs)} мс`,
  )
}

describe('мова й тип тексту видання (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let merge: MergeService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    // Злиття — адмінська CLI-операція й не частина `AppModule`; сервіс бере ту саму базу, що й застосунок.
    merge = new MergeService(prisma)
  })

  afterAll(async () => {
    await app.close()
  })

  interface Account {
    id: string
    cookie: string
  }

  const token = (): string => `Lng${randomUUID().replaceAll('-', '').slice(0, 12)}`

  async function work(
    account: Account,
    origLang: string | null,
  ): Promise<{ id: string; title: string }> {
    const title = token()
    const created = await prisma.work.create({
      data: { title, titleNorm: title.toLowerCase(), origLang, createdById: account.id },
    })

    return { id: created.id, title }
  }

  async function translation(account: Account, workId: string, lang: string): Promise<string> {
    const created = await prisma.translation.create({
      data: {
        workId,
        translator: `Перекладач ${lang}`,
        lang,
        sourceLang: 'en',
        createdById: account.id,
      },
    })

    return created.id
  }

  interface EditionSeed {
    textKind: EditionTextKind
    lang: string | null
    translationId?: string | null
    format?: 'PAPERBACK' | null
  }

  async function edition(account: Account, workId: string, seed: EditionSeed): Promise<string> {
    const created = await prisma.edition.create({
      data: {
        workId,
        createdById: account.id,
        textKind: seed.textKind,
        lang: seed.lang,
        translationId: seed.translationId ?? null,
        ...(seed.format === undefined ? {} : { format: seed.format }),
      },
    })

    return created.id
  }

  const patchWork = (account: Account, workId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(url(`/works/${workId}`))
      .set('Cookie', account.cookie)
      .send(body)

  const patchTranslation = (account: Account, id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(url(`/translations/${id}`))
      .set('Cookie', account.cookie)
      .send(body)

  const patchEdition = (account: Account, id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(url(`/editions/${id}`))
      .set('Cookie', account.cookie)
      .send(body)

  const row = (id: string) => prisma.edition.findUniqueOrThrow({ where: { id } })
  const revisions = (editionId: string) =>
    prisma.catalogRevision.findMany({
      where: { entityType: 'EDITION', entityId: editionId },
      orderBy: { createdAt: 'asc' },
    })

  describe('читачі', () => {
    it('GET /works/:id віддає тип тексту й мову видання як власні поля', async () => {
      const account = await registerAccount(app, 'lang-read')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const original = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })
      const translated = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'uk',
        translationId: tr,
      })

      const response = await request(app.getHttpServer())
        .get(url(`/works/${w.id}`))
        .set('Cookie', account.cookie)
        .expect(200)
      const byId = new Map(
        workDetailResponseSchema.parse(response.body).editions.map((item) => [item.id, item]),
      )

      expect(byId.get(original)).toMatchObject({
        textKind: 'ORIGINAL',
        lang: 'en',
        translator: null,
      })
      expect(byId.get(translated)).toMatchObject({
        textKind: 'TRANSLATION',
        lang: 'uk',
        translator: 'Перекладач uk',
      })
    })

    it('нові рядки (UNKNOWN, невідома мова, невідомий формат) читаються без вигаданих значень', async () => {
      const account = await registerAccount(app, 'lang-unknown')
      const w = await work(account, null)
      const unknown = await edition(account, w.id, {
        textKind: 'UNKNOWN',
        lang: null,
        format: null,
      })

      const response = await request(app.getHttpServer())
        .get(url(`/editions/${unknown}`))
        .set('Cookie', account.cookie)
        .expect(200)
      const body = response.body as {
        edition: { textKind: string; lang: string | null; format: string | null }
        work: { origLang: string | null }
      }

      expect(body.edition).toMatchObject({ textKind: 'UNKNOWN', lang: null, format: null })
      expect(body.work.origLang).toBeNull()
    })

    it('фільтр бібліотеки за мовою: оригінали, переклади й UNKNOWN із відомою мовою; без мови — у жоден', async () => {
      const account = await registerAccount(app, 'lang-filter')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const ids = {
        newOriginal: await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' }),
        newTranslated: await edition(account, w.id, {
          textKind: 'TRANSLATION',
          lang: 'uk',
          translationId: tr,
        }),
        unknownDe: await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'de' }),
        unknownNone: await edition(account, w.id, { textKind: 'UNKNOWN', lang: null }),
      }

      for (const editionId of Object.values(ids)) {
        await request(app.getHttpServer())
          .post(url('/me/library'))
          .set('Cookie', account.cookie)
          .send({ editionId })
          .expect(201)
      }

      const editionsOf = async (lang: string): Promise<string[]> => {
        const response = await request(app.getHttpServer())
          .get(url(`/me/library?lang=${lang}`))
          .set('Cookie', account.cookie)
          .expect(200)

        return (response.body as { groups: { edition: { id: string } }[] }).groups
          .map((group) => group.edition.id)
          .sort()
      }

      expect(await editionsOf('en')).toEqual([ids.newOriginal])
      expect(await editionsOf('uk')).toEqual([ids.newTranslated])
      expect(await editionsOf('de')).toEqual([ids.unknownDe])
    })

    it('«Хто має цю книжку?»: невідомий текст — окрема група, а не «оригінал»', async () => {
      const owner = await registerAccount(app, 'lang-holder')
      const viewer = await registerAccount(app, 'lang-viewer')
      const w = await work(owner, 'en')
      const original = await edition(owner, w.id, { textKind: 'ORIGINAL', lang: 'en' })
      const unknown = await edition(owner, w.id, { textKind: 'UNKNOWN', lang: null })

      await request(app.getHttpServer())
        .post(url('/friends/requests'))
        .set('Cookie', owner.cookie)
        .send({ userId: viewer.id })
        .expect(201)
      await request(app.getHttpServer())
        .post(url('/friends/requests'))
        .set('Cookie', viewer.cookie)
        .send({ userId: owner.id })
        .expect(201)

      for (const editionId of [original, unknown]) {
        await request(app.getHttpServer())
          .post(url('/me/library'))
          .set('Cookie', owner.cookie)
          .send({ editionId, visibility: 'FRIENDS' })
          .expect(201)
      }

      const response = await request(app.getHttpServer())
        .get(url(`/works/${w.id}/holders`))
        .set('Cookie', viewer.cookie)
        .expect(200)
      const groups = (response.body as { groups: { textKind: string; language: string | null }[] })
        .groups

      expect(groups.map((group) => group.textKind)).toEqual(['ORIGINAL', 'UNKNOWN'])
      expect(groups[1]?.language).toBeNull()

      const onlyOriginal = await request(app.getHttpServer())
        .get(url(`/works/${w.id}/holders?translationId=original`))
        .set('Cookie', viewer.cookie)
        .expect(200)

      expect((onlyOriginal.body as { groups: unknown[] }).groups).toHaveLength(1)
    })
  })

  describe('записувачі: явні значення', () => {
    it('POST /works/:id/editions: оригінал → ORIGINAL і мова твору; з перекладом → TRANSLATION і його мова', async () => {
      const account = await registerAccount(app, 'lang-write')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')

      const original = editionResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .post(url(`/works/${w.id}/editions`))
            .set('Cookie', account.cookie)
            .send({ publisher: 'КСД' })
            .expect(201)
        ).body,
      ).edition
      const translated = editionResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .post(url(`/works/${w.id}/editions`))
            .set('Cookie', account.cookie)
            .send({ translationId: tr })
            .expect(201)
        ).body,
      ).edition

      expect(original).toMatchObject({ textKind: 'ORIGINAL', lang: 'en', format: null })
      expect(translated).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk' })
      expect(await row(original.id)).toMatchObject({ textKind: 'ORIGINAL', lang: 'en' })
      expect(await row(translated.id)).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk' })
    })

    it('створення оригіналу на творі з невідомою мовою не вигадує її', async () => {
      const account = await registerAccount(app, 'lang-write-null')
      const w = await work(account, null)
      const created = editionResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .post(url(`/works/${w.id}/editions`))
            .set('Cookie', account.cookie)
            .send({})
            .expect(201)
        ).body,
      ).edition

      expect(created).toMatchObject({ textKind: 'ORIGINAL', lang: null })
    })
  })

  describe('PATCH твору: каскад мови оригіналу (I3)', () => {
    it('мова оригіналу en → uk веде видання-оригінали за собою; переклади й UNKNOWN не чіпає; є аудит', async () => {
      const account = await registerAccount(app, 'lang-cascade')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'de')
      const originalA = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })
      const originalNull = await edition(account, w.id, { textKind: 'ORIGINAL', lang: null })
      const translated = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'de',
        translationId: tr,
      })
      const unknown = await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'fr' })

      await patchWork(account, w.id, { expectedRevision: 1, origLang: 'uk' }).expect(200)

      expect((await row(originalA)).lang).toBe('uk')
      expect((await row(originalNull)).lang).toBe('uk')
      expect((await row(translated)).lang).toBe('de')
      expect((await row(unknown)).lang).toBe('fr')

      const [audit, ...more] = await revisions(originalA)

      expect(more).toHaveLength(0)
      expect(audit).toMatchObject({ actorId: account.id, fromRevision: 1, toRevision: 2 })
      expect((audit?.before as { lang: string }).lang).toBe('en')
      expect((audit?.after as { lang: string }).lang).toBe('uk')
      expect(await revisions(translated)).toHaveLength(0)
    })

    it('мова оригіналу невідома, видання вже має uk → задати uk: успіх, нічого не змінюється', async () => {
      const account = await registerAccount(app, 'lang-null-same')
      const w = await work(account, null)
      const e = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'uk' })

      await patchWork(account, w.id, { expectedRevision: 1, origLang: 'uk' }).expect(200)

      expect((await prisma.work.findUniqueOrThrow({ where: { id: w.id } })).origLang).toBe('uk')
      expect(await row(e)).toMatchObject({ lang: 'uk', revision: 1 })
      expect(await revisions(e)).toHaveLength(0)
    })

    it('мова оригіналу невідома, видання має en → задати uk: конфлікт і відкат УСІЄЇ операції', async () => {
      const account = await registerAccount(app, 'lang-null-conflict')
      const w = await work(account, null)
      const fine = await edition(account, w.id, { textKind: 'ORIGINAL', lang: null })
      const clash = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })

      const response = await patchWork(account, w.id, {
        expectedRevision: 1,
        origLang: 'uk',
        title: 'Нова назва, що теж не збережеться',
      }).expect(409)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT)
      expect((error.details as { editionIds: string[] }).editionIds).toEqual([clash])

      const unchanged = await prisma.work.findUniqueOrThrow({ where: { id: w.id } })

      expect(unchanged).toMatchObject({ origLang: null, revision: 1 })
      expect(unchanged.title).toBe(w.title)
      expect(await row(fine)).toMatchObject({ lang: null, revision: 1 })
      expect(await row(clash)).toMatchObject({ lang: 'en', revision: 1 })
      expect(
        await prisma.catalogRevision.count({ where: { entityId: { in: [w.id, fine, clash] } } }),
      ).toBe(0)
    })
  })

  describe('PATCH перекладу: каскад мови (I2)', () => {
    it('мова перекладу веде видання за ним, з аудитом на кожне', async () => {
      const account = await registerAccount(app, 'lang-tr-cascade')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'de')
      const explicit = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'de',
        translationId: tr,
      })
      const second = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'de',
        translationId: tr,
      })

      await patchTranslation(account, tr, { expectedRevision: 1, lang: 'pl' }).expect(200)

      expect(await row(explicit)).toMatchObject({ lang: 'pl', revision: 2 })
      expect(await row(second)).toMatchObject({ lang: 'pl', revision: 2 })
      expect(await revisions(explicit)).toHaveLength(1)
      expect(await revisions(second)).toHaveLength(1)

      const detail = await request(app.getHttpServer())
        .get(url(`/works/${w.id}`))
        .set('Cookie', account.cookie)
        .expect(200)
      const langs = new Map(
        workDetailResponseSchema.parse(detail.body).editions.map((item) => [item.id, item.lang]),
      )

      expect(langs.get(explicit)).toBe('pl')
      expect(langs.get(second)).toBe('pl')
    })
  })

  describe('PATCH видання: привʼязування й відвʼязування перекладу', () => {
    it('привʼязування: тип TRANSLATION, мова — мова перекладу', async () => {
      const account = await registerAccount(app, 'lang-link')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })

      await patchEdition(account, e, { expectedRevision: 1, translationId: tr }).expect(200)

      expect(await row(e)).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk', translationId: tr })
    })

    it('привʼязування до видання з НЕЗАЛЕЖНО відомою суперечливою мовою — конфлікт, нічого не змінено', async () => {
      const account = await registerAccount(app, 'lang-link-conflict')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'de' })

      const response = await patchEdition(account, e, {
        expectedRevision: 1,
        translationId: tr,
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT,
      )
      expect(await row(e)).toMatchObject({ textKind: 'UNKNOWN', lang: 'de', translationId: null })
    })

    it('відвʼязування: стара семантика «оригінал» із мовою твору', async () => {
      const account = await registerAccount(app, 'lang-unlink')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'uk',
        translationId: tr,
      })

      await patchEdition(account, e, { expectedRevision: 1, translationId: null }).expect(200)

      expect(await row(e)).toMatchObject({ textKind: 'ORIGINAL', lang: 'en', translationId: null })
    })

    it('відвʼязування на творі з невідомою мовою оригіналу — 422: потрібен явний тип', async () => {
      const account = await registerAccount(app, 'lang-unlink-null')
      const w = await work(account, null)
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'uk',
        translationId: tr,
      })

      const response = await patchEdition(account, e, {
        expectedRevision: 1,
        translationId: null,
      }).expect(422)
      const error = apiErrorSchema.parse(response.body)

      expect(error.code).toBe(API_ERROR_CODES.EDITION_TEXT_KIND_CONFLICT)
      expect(error.details).toEqual({ reason: 'UNLINK_NEEDS_KIND' })
      expect(await row(e)).toMatchObject({ translationId: tr, textKind: 'TRANSLATION', lang: 'uk' })
    })

    it('PATCH без translationId не чіпає тип тексту й мову', async () => {
      const account = await registerAccount(app, 'lang-untouched')
      const w = await work(account, null)
      const e = await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'de' })

      await patchEdition(account, e, { expectedRevision: 1, publisher: 'Нове' }).expect(200)

      expect(await row(e)).toMatchObject({ textKind: 'UNKNOWN', lang: 'de', publisher: 'Нове' })
    })
  })

  describe('PATCH видання: прямі textKind і lang — матриця переходів через API', () => {
    it('UNKNOWN → ORIGINAL на творі з відомою мовою: невідома мова заповнюється; відома інша — конфлікт без змін', async () => {
      const account = await registerAccount(app, 'lang-matrix-unknown')
      const w = await work(account, 'en')
      const empty = await edition(account, w.id, { textKind: 'UNKNOWN', lang: null })
      const clash = await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'de' })

      await patchEdition(account, empty, { expectedRevision: 1, textKind: 'ORIGINAL' }).expect(200)

      expect(await row(empty)).toMatchObject({ textKind: 'ORIGINAL', lang: 'en', revision: 2 })

      const response = await patchEdition(account, clash, {
        expectedRevision: 1,
        textKind: 'ORIGINAL',
      }).expect(409)

      expect(apiErrorSchema.parse(response.body).code).toBe(
        API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT,
      )
      expect(await row(clash)).toMatchObject({ textKind: 'UNKNOWN', lang: 'de', revision: 1 })
    })

    it('UNKNOWN → ORIGINAL на творі без мови: введена мова видання зберігається, твір не змінюється', async () => {
      const account = await registerAccount(app, 'lang-matrix-null-work')
      const w = await work(account, null)
      const e = await edition(account, w.id, { textKind: 'UNKNOWN', lang: 'de' })

      await patchEdition(account, e, { expectedRevision: 1, textKind: 'ORIGINAL' }).expect(200)

      expect(await row(e)).toMatchObject({ textKind: 'ORIGINAL', lang: 'de' })
      expect((await prisma.work.findUniqueOrThrow({ where: { id: w.id } })).origLang).toBeNull()
    })

    it('ORIGINAL → UNKNOWN і ORIGINAL → TRANSLATION без зв\u02bcязку: мова зберігається', async () => {
      const account = await registerAccount(app, 'lang-matrix-demote')
      const w = await work(account, 'en')
      const a = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })
      const b = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })

      await patchEdition(account, a, { expectedRevision: 1, textKind: 'UNKNOWN' }).expect(200)
      await patchEdition(account, b, { expectedRevision: 1, textKind: 'TRANSLATION' }).expect(200)

      expect(await row(a)).toMatchObject({ textKind: 'UNKNOWN', lang: 'en', translationId: null })
      expect(await row(b)).toMatchObject({
        textKind: 'TRANSLATION',
        lang: 'en',
        translationId: null,
      })
    })

    it('прив\u02bcязаний переклад: інший тип тексту — 422; лише мова, що суперечить перекладу, — конфлікт', async () => {
      const account = await registerAccount(app, 'lang-matrix-linked')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'uk',
        translationId: tr,
      })

      const kind = await patchEdition(account, e, {
        expectedRevision: 1,
        textKind: 'ORIGINAL',
      }).expect(422)

      expect(apiErrorSchema.parse(kind.body)).toMatchObject({
        code: API_ERROR_CODES.EDITION_TEXT_KIND_CONFLICT,
        details: { reason: 'KIND_REQUIRES_UNLINK' },
      })

      const lang = await patchEdition(account, e, { expectedRevision: 1, lang: 'pl' }).expect(409)

      expect(apiErrorSchema.parse(lang.body).code).toBe(API_ERROR_CODES.EDITION_LANGUAGE_CONFLICT)
      expect(await row(e)).toMatchObject({ textKind: 'TRANSLATION', lang: 'uk', revision: 1 })
    })

    it('відв\u02bcязування з явним типом UNKNOWN: переклад знято, мова видання зберігається', async () => {
      const account = await registerAccount(app, 'lang-matrix-unlink-unknown')
      const w = await work(account, null)
      const tr = await translation(account, w.id, 'uk')
      const e = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'uk',
        translationId: tr,
      })

      await patchEdition(account, e, {
        expectedRevision: 1,
        translationId: null,
        textKind: 'UNKNOWN',
      }).expect(200)

      expect(await row(e)).toMatchObject({ textKind: 'UNKNOWN', lang: 'uk', translationId: null })
    })

    it('формат можна очистити: «невідомо» — це null, а не «м\u02bcяка»', async () => {
      const account = await registerAccount(app, 'lang-matrix-format')
      const w = await work(account, 'en')
      const e = await edition(account, w.id, {
        textKind: 'ORIGINAL',
        lang: 'en',
        format: 'PAPERBACK',
      })

      await patchEdition(account, e, { expectedRevision: 1, format: null }).expect(200)

      expect((await row(e)).format).toBeNull()
    })

    it('аудит: зміна типу тексту й мови потрапляє в before/after', async () => {
      const account = await registerAccount(app, 'lang-matrix-audit')
      const w = await work(account, 'en')
      const e = await edition(account, w.id, { textKind: 'UNKNOWN', lang: null })

      await patchEdition(account, e, { expectedRevision: 1, textKind: 'ORIGINAL' }).expect(200)

      const [audit] = await revisions(e)

      expect(audit?.before).toMatchObject({ textKind: 'UNKNOWN', lang: null })
      expect(audit?.after).toMatchObject({ textKind: 'ORIGINAL', lang: 'en' })
    })
  })

  describe('PATCH твору: очищення мови оригіналу', () => {
    it('origLang: null — мова невідома, видання не змінюються й нічого не губиться', async () => {
      const account = await registerAccount(app, 'lang-clear-orig')
      const w = await work(account, 'en')
      const e = await edition(account, w.id, { textKind: 'ORIGINAL', lang: 'en' })

      await patchWork(account, w.id, { expectedRevision: 1, origLang: null }).expect(200)

      expect((await prisma.work.findUniqueOrThrow({ where: { id: w.id } })).origLang).toBeNull()
      expect(await row(e)).toMatchObject({ textKind: 'ORIGINAL', lang: 'en', revision: 1 })
    })
  })

  describe('злиття творів: мову видання не губимо й не підміняємо', () => {
    async function merged(sourceLang: string | null, targetLang: string | null) {
      const owner = await registerAccount(app, 'lang-merge')
      const source = await work(owner, sourceLang)
      const target = await work(owner, targetLang)
      const tr = await translation(owner, source.id, 'de')

      return {
        owner,
        source,
        target,
        original: await edition(owner, source.id, { textKind: 'ORIGINAL', lang: sourceLang }),
        translated: await edition(owner, source.id, {
          textKind: 'TRANSLATION',
          lang: 'de',
          translationId: tr,
        }),
        unknown: await edition(owner, source.id, { textKind: 'UNKNOWN', lang: 'fr' }),
      }
    }

    it('ціль без мови: відома мова оригіналу видання лишається, мову цілі злиття не вигадує', async () => {
      const fixture = await merged('en', null)
      const summary = await merge.merge(fixture.source.id, fixture.target.id)

      expect(summary.editionLanguagesSet).toBe(0)
      expect(await row(fixture.original)).toMatchObject({
        workId: fixture.target.id,
        lang: 'en',
        textKind: 'ORIGINAL',
        revision: 1,
      })
      expect(
        (await prisma.work.findUniqueOrThrow({ where: { id: fixture.target.id } })).origLang,
      ).toBeNull()
    })

    it('ціль із мовою, збіг: без змін', async () => {
      const fixture = await merged('uk', 'uk')

      await merge.merge(fixture.source.id, fixture.target.id)

      expect(await row(fixture.original)).toMatchObject({ lang: 'uk', revision: 1 })
    })

    it('ціль із мовою, у видання вона невідома — заповнюється мовою цілі', async () => {
      const fixture = await merged(null, 'uk')

      const summary = await merge.merge(fixture.source.id, fixture.target.id)

      expect(summary.editionLanguagesSet).toBe(1)
      expect(await row(fixture.original)).toMatchObject({ lang: 'uk', revision: 2 })

      const [audit] = await revisions(fixture.original)

      // Зміну зробив оператор через CLI, а не людина із сесії.
      expect(audit).toMatchObject({ actorId: null })
    })

    it('різні ВІДОМІ мови — злиття відхилено, нічого не змінено', async () => {
      const fixture = await merged('en', 'uk')

      await expect(merge.merge(fixture.source.id, fixture.target.id)).rejects.toMatchObject({
        code: WORK_MERGE_ERROR_CODES.WORK_MERGE_LANGUAGE_CONFLICT,
      })
      await expect(merge.merge(fixture.source.id, fixture.target.id)).rejects.toBeInstanceOf(
        WorkMergeError,
      )

      const source = await prisma.work.findUniqueOrThrow({ where: { id: fixture.source.id } })

      expect(source.mergedIntoId).toBeNull()
      expect(await prisma.edition.count({ where: { workId: fixture.source.id } })).toBe(3)
      expect(await row(fixture.original)).toMatchObject({ lang: 'en', workId: fixture.source.id })
    })

    it('переклади й невідомий текст переносяться без змін', async () => {
      const fixture = await merged('uk', 'uk')

      await merge.merge(fixture.source.id, fixture.target.id)

      expect(await row(fixture.translated)).toMatchObject({
        workId: fixture.target.id,
        textKind: 'TRANSLATION',
        lang: 'de',
      })
      expect(await row(fixture.unknown)).toMatchObject({
        workId: fixture.target.id,
        textKind: 'UNKNOWN',
        lang: 'fr',
      })
    })
  })

  describe('конкурентність: єдиний порядок блокувань Work → Translation → Edition', () => {
    it('створення видання чекає, поки твір заблоковано, і читає мову ПІСЛЯ його зміни', async () => {
      const account = await registerAccount(app, 'lang-race-create')
      const w = await work(account, 'en')
      const entered = deferred()
      const release = deferred()

      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${w.id} FOR UPDATE`
          entered.resolve()
          await release.promise
          await tx.work.update({ where: { id: w.id }, data: { origLang: 'pl' } })
        },
        { timeout: 30_000 },
      )

      await entered.promise

      const creating = beginRequest(
        request(app.getHttpServer())
          .post(url(`/works/${w.id}/editions`))
          .set('Cookie', account.cookie)
          .send({ publisher: 'Гонка' }),
      )

      await waitForBlockedBackend(prisma)
      release.resolve()
      await holder

      const response = await creating

      expect(response.status).toBe(201)

      const created = editionResponseSchema.parse(response.body).edition

      expect(created).toMatchObject({ textKind: 'ORIGINAL', lang: 'pl' })
      expect(await row(created.id)).toMatchObject({ lang: 'pl' })
    })

    it('PATCH мови перекладу чекає на твір, а не бере блокування навиворіт', async () => {
      const account = await registerAccount(app, 'lang-race-translation')
      const w = await work(account, 'en')
      const tr = await translation(account, w.id, 'de')
      const linked = await edition(account, w.id, {
        textKind: 'TRANSLATION',
        lang: 'de',
        translationId: tr,
      })
      const entered = deferred()
      const release = deferred()
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${w.id} FOR UPDATE`
          entered.resolve()
          await release.promise
        },
        { timeout: 30_000 },
      )

      await entered.promise

      const patching = beginRequest(
        patchTranslation(account, tr, { expectedRevision: 1, lang: 'pl' }),
      )

      await waitForBlockedBackend(prisma)
      release.resolve()
      await holder

      expect((await patching).status).toBe(200)
      expect(await row(linked)).toMatchObject({ lang: 'pl' })
    })

    /**
     * Сутність переїхала до іншого твору (злиття) МІЖ читанням workId і блокуванням (ред. 2.1, правка 3).
     * Операція не має права блокувати новий `Work` під уже захопленими блокуваннями старого `Work` і самої
     * сутності: інша транзакція, що тримає новий `Work`, чекає саме на цю сутність — взаємне очікування.
     * Транзакція мусить завершитися, а повторити її має нова — після цього все проходить без дедлоку.
     */
    describe.each([
      ['видання', 'Edition'],
      ['переклад', 'Translation'],
    ] as const)('%s переїхало між читанням і блокуванням', (_name, table) => {
      it('не блокує новий твір під захопленими блокуваннями: без дедлоку, операція завершується після повтору', async () => {
        const account = await registerAccount(app, `lang-race-moved-${table.toLowerCase()}`)
        const from = await work(account, 'en')
        const to = await work(account, 'en')
        const translationId = await translation(account, from.id, 'de')
        const editionId = await edition(account, from.id, { textKind: 'UNKNOWN', lang: null })
        const entityId = table === 'Edition' ? editionId : translationId
        const lockedFrom = deferred()
        const releaseFrom = deferred()
        const lockedTo = deferred()
        const releaseTo = deferred()
        let holderPid = 0

        // «Злиття» вже тримає старий твір.
        const merging = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${from.id} FOR UPDATE`
            lockedFrom.resolve()
            await releaseFrom.promise

            if (table === 'Edition') {
              await tx.edition.update({ where: { id: editionId }, data: { workId: to.id } })
            } else {
              await tx.translation.update({ where: { id: translationId }, data: { workId: to.id } })
            }
          },
          { timeout: 30_000 },
        )

        await lockedFrom.promise

        const patching = beginRequest(
          table === 'Edition'
            ? patchEdition(account, editionId, { expectedRevision: 1, publisher: 'Після переїзду' })
            : patchTranslation(account, translationId, { expectedRevision: 1, lang: 'pl' }),
        )

        // PATCH прочитав старий workId й чекає на старий твір.
        await waitForBlockedBackend(prisma)

        // Інша операція тримає НОВИЙ твір і згодом захоче саму сутність.
        const holder = prisma.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`

            holderPid = row?.pid ?? 0
            // FOR NO KEY UPDATE, а не FOR UPDATE: «злиття» нижче змінює `workId` видання, і зовнішній ключ бере на
            // новому творі FOR KEY SHARE, з яким цей режим сумісний; а `lockWork` застосунку (FOR UPDATE) він блокує.
            await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${to.id} FOR NO KEY UPDATE`
            lockedTo.resolve()
            await releaseTo.promise
            await tx.$executeRawUnsafe(
              `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
              entityId,
            )
          },
          { timeout: 30_000 },
        )

        await lockedTo.promise
        releaseFrom.resolve()
        await merging

        // PATCH прокинувся, побачив переїзд і чекає на новий твір, що його тримає `holder`.
        await waitUntilBlockedBy(prisma, holderPid)

        // Тепер `holder` бере саму сутність. Зі старим кодом PATCH уже тримав би її й чекав на новий твір —
        // дедлок; з новим він нічого не тримає й пропускає `holder`.
        releaseTo.resolve()
        await holder

        const response = await patching

        expect(response.status).toBe(200)

        if (table === 'Edition') {
          expect(await row(editionId)).toMatchObject({
            workId: to.id,
            publisher: 'Після переїзду',
            revision: 2,
          })
        } else {
          expect(
            await prisma.translation.findUniqueOrThrow({ where: { id: translationId } }),
          ).toMatchObject({ workId: to.id, lang: 'pl', revision: 2 })
        }
      }, 30_000)
    })

    it('PATCH мови оригіналу ∥ створення оригіналу: у будь-якому порядку I3 виконано', async () => {
      for (let round = 0; round < 4; round += 1) {
        const account = await registerAccount(app, `lang-race-i3-${String(round)}`)
        const w = await work(account, 'en')
        const [patched, created] = await Promise.all([
          beginRequest(patchWork(account, w.id, { expectedRevision: 1, origLang: 'uk' })),
          beginRequest(
            request(app.getHttpServer())
              .post(url(`/works/${w.id}/editions`))
              .set('Cookie', account.cookie)
              .send({ publisher: 'Гонка' }),
          ),
        ])

        expect([patched.status, created.status]).toEqual([200, 201])

        const stored = await prisma.edition.findMany({ where: { workId: w.id } })

        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ textKind: 'ORIGINAL', lang: 'uk' })
      }
    })

    it('злиття ∥ PATCH мови перекладу: без дедлоку, обидва завершуються', async () => {
      for (let round = 0; round < 3; round += 1) {
        const account = await registerAccount(app, `lang-race-merge-${String(round)}`)
        const source = await work(account, 'uk')
        const target = await work(account, 'uk')
        const tr = await translation(account, source.id, 'de')

        await edition(account, source.id, {
          textKind: 'TRANSLATION',
          lang: 'de',
          translationId: tr,
        })

        const [merged, patched] = await Promise.allSettled([
          merge.merge(source.id, target.id),
          beginRequest(patchTranslation(account, tr, { expectedRevision: 1, lang: 'pl' })),
        ])

        expect(merged.status).toBe('fulfilled')
        expect(patched.status).toBe('fulfilled')

        const stored = await prisma.edition.findMany({ where: { translationId: tr } })

        expect(stored.every((item) => item.workId === target.id)).toBe(true)

        const finalTranslation = await prisma.translation.findUniqueOrThrow({ where: { id: tr } })

        // Який би порядок не склався, I2 виконано: мова видання = мова перекладу.
        expect(stored.every((item) => item.lang === finalTranslation.lang)).toBe(true)
      }
    })
  })
})
