import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import { CatalogService } from '../src/catalog/catalog.service'
import { MergeCliModule } from '../src/cli/merge-cli.module'
import { WORK_MERGE_ERROR_CODES, WorkMergeError } from '../src/catalog/merge/merge-errors'
import { MergeService } from '../src/catalog/merge/merge.service'
import { PrismaService } from '../src/prisma/prisma.service'
import { createGraph, createUser } from './db/fixtures'
import { createTestApp } from './auth.helpers'
import type { WorkMergeErrorCode } from '../src/catalog/merge/merge-errors'
import type { AuthorRole } from '../src/generated/prisma/enums'

/**
 * §6.3 «мердж дублікатів», підетап 7g.
 *
 * Піднімається САМЕ `MergeCliModule` — той самий модуль, що й у
 * `src/cli/merge-works.ts`. Так перевіряється не лише логіка сервісу, а й те, що
 * адмінська команда взагалі збирається: якщо DI розсиплеться, ляже цей файл, а
 * не оператор посеред злиття.
 *
 * ВАЖЛИВО про ізоляцію: e2e-файли ділять одну тестову базу й нічого не чистять
 * між тестами (див. `friends.e2e-spec.ts`). Кожна перевірка звужена за id творів.
 */
describe('Мерж творів (e2e)', () => {
  let context: INestApplicationContext
  let prisma: PrismaService
  let merge: MergeService

  beforeAll(async () => {
    // Скомпільований `TestingModule` сам є контекстом застосунку — HTTP-шар тут
    // ні до чого. `init()` потрібен явно: без нього не спрацює `onModuleInit`
    // у `PrismaService`, а `close()` не закриє підключення.
    context = await Test.createTestingModule({ imports: [MergeCliModule] }).compile()
    await context.init()

    prisma = context.get(PrismaService)
    merge = context.get(MergeService)
  })

  afterAll(async () => {
    await context.close()
  })

  /** Два незалежні повні ланцюги §3 на одного власника. */
  async function twoWorks(): Promise<{ source: string; target: string; ownerId: string }> {
    const ownerId = await createUser(prisma, 'Адмін мержу')
    const source = await createGraph(prisma, { ownerId })
    const target = await createGraph(prisma, { ownerId })

    return { source: source.workId, target: target.workId, ownerId }
  }

  async function bareWork(createdById: string): Promise<string> {
    const work = await prisma.work.create({
      data: { title: 'Дублікат', titleNorm: 'дублікат', origLang: 'uk', createdById },
    })

    return work.id
  }

  /**
   * TD-06: fixtures for `WorkAuthor` links.
   *
   * `nameNorm` is set right here, without calling `bookswap_norm` — same as
   * `titleNorm` in `bareWork` above: the merge neither reads nor counts this
   * column, so any lowercase value works.
   */
  async function createAuthor(name: string): Promise<string> {
    const author = await prisma.author.create({ data: { name, nameNorm: name.toLowerCase() } })

    return author.id
  }

  async function linkAuthor(
    workId: string,
    authorId: string,
    role: AuthorRole = 'AUTHOR',
  ): Promise<void> {
    // Stage 8e-1, R10a: `position` — сервер призначає за порядком додавання;
    // тут це просто «наступний вільний номер» для цього твору.
    const position = await prisma.workAuthor.count({ where: { workId } })

    await prisma.workAuthor.create({ data: { workId, authorId, role, position } })
  }

  async function authorLinks(workId: string): Promise<{ authorId: string; role: AuthorRole }[]> {
    return prisma.workAuthor.findMany({
      where: { workId },
      select: { authorId: true, role: true },
      orderBy: [{ authorId: 'asc' }, { role: 'asc' }],
    })
  }

  /** Stage 8e-1, R10a: за `position`, а не за `authorId`/`role` — порядок є те, що перевіряється. */
  async function authorLinksByPosition(
    workId: string,
  ): Promise<{ authorId: string; role: AuthorRole; position: number }[]> {
    return prisma.workAuthor.findMany({
      where: { workId },
      select: { authorId: true, role: true, position: true },
      orderBy: { position: 'asc' },
    })
  }

  /**
   * `updatedAt` задається явно: тай-брейк R5 порівнює саме його, а два рядки,
   * створені підряд, отримали б значення, що відрізняються на випадкові
   * мілісекунди — тест був би нестабільним.
   */
  async function createReview(
    workId: string,
    userId: string,
    updatedAt: Date,
    text: string,
  ): Promise<string> {
    const review = await prisma.review.create({
      data: { workId, userId, rating: 5, text, updatedAt },
    })

    return review.id
  }

  async function expectRefusal(promise: Promise<unknown>, code: WorkMergeErrorCode): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(WorkMergeError)
    await expect(promise).rejects.toMatchObject({ code })
  }

  it('переносить увесь ланцюг і лишає вихідний твір живим', async () => {
    const { source, target, ownerId } = await twoWorks()
    const reader = await createUser(prisma, 'Читач')

    await prisma.wishlistItem.create({ data: { userId: reader, workId: source } })
    await createReview(source, reader, new Date('2026-01-01T00:00:00Z'), 'Відгук з дубліката')

    const sourceCopyIds = (
      await prisma.copy.findMany({
        where: { edition: { workId: source } },
        select: { id: true },
      })
    ).map((copy) => copy.id)

    const summary = await merge.merge(source, target)

    expect(summary).toMatchObject({
      sourceWorkId: source,
      targetWorkId: target,
      translationsMoved: 1,
      editionsMoved: 1,
      reviewsMoved: 1,
      reviewsArchived: 0,
      wishlistItemsMoved: 1,
      wishlistDuplicatesRemoved: 0,
      incomingMergesRepointed: 0,
    })

    await expect(prisma.translation.count({ where: { workId: source } })).resolves.toBe(0)
    await expect(prisma.edition.count({ where: { workId: source } })).resolves.toBe(0)
    await expect(prisma.review.count({ where: { workId: source } })).resolves.toBe(0)
    await expect(prisma.wishlistItem.count({ where: { workId: source } })).resolves.toBe(0)

    await expect(prisma.translation.count({ where: { workId: target } })).resolves.toBe(2)
    await expect(prisma.edition.count({ where: { workId: target } })).resolves.toBe(2)
    await expect(prisma.review.count({ where: { workId: target } })).resolves.toBe(1)
    await expect(prisma.wishlistItem.count({ where: { workId: target } })).resolves.toBe(1)

    // §3: `Copy` висить на `Edition`, тож переїжджає разом із ним, а не окремо.
    await expect(
      prisma.copy.count({ where: { id: { in: sourceCopyIds }, edition: { workId: target } } }),
    ).resolves.toBe(sourceCopyIds.length)

    // §6.3: старий запис не видаляється — інакше вмирають зовнішні посилання.
    await expect(
      prisma.work.findUnique({ where: { id: source }, select: { mergedIntoId: true } }),
    ).resolves.toEqual({ mergedIntoId: target })

    expect(ownerId).toBeDefined()
  })

  it('R5: конфліктні рецензії — жоден рядок не зникає, активною лишається новіша', async () => {
    const { source, target } = await twoWorks()
    const reader = await createUser(prisma, 'Подвійний рецензент')

    const older = await createReview(source, reader, new Date('2026-01-01T00:00:00Z'), 'Старіший')
    const newer = await createReview(target, reader, new Date('2026-02-01T00:00:00Z'), 'Новіший')

    const before = await prisma.review.count({ where: { userId: reader } })

    const summary = await merge.merge(source, target)

    expect(summary.reviewsArchived).toBe(1)

    // DoD: тест рахує кількість рецензій до і після.
    await expect(prisma.review.count({ where: { userId: reader } })).resolves.toBe(before)
    expect(before).toBe(2)

    const rows = await prisma.review.findMany({
      where: { userId: reader },
      select: {
        id: true,
        workId: true,
        text: true,
        archivedAt: true,
        archivedByMergeSourceId: true,
      },
    })

    // Обидві опинилися на канонічному творі — архівна теж, інакше 7h її не побачить.
    expect(rows.every((row) => row.workId === target)).toBe(true)

    const active = rows.filter((row) => row.archivedAt === null)
    const archived = rows.filter((row) => row.archivedAt !== null)

    expect(active).toHaveLength(1)
    expect(active[0]?.id).toBe(newer)
    expect(archived).toHaveLength(1)
    expect(archived[0]?.id).toBe(older)
    expect(archived[0]?.text).toBe('Старіший')
    expect(archived[0]?.archivedByMergeSourceId).toBe(source)
  })

  it('R5: мерж не вдає редагування — `updatedAt` перенесених рецензій не зсувається', async () => {
    const { source, target } = await twoWorks()
    const reader = await createUser(prisma, 'Рецензент без конфлікту')
    const stamp = new Date('2026-03-04T05:06:07.000Z')

    const id = await createReview(source, reader, stamp, 'Без конфлікту')

    await merge.merge(source, target)

    // Якби перенос ішов через `updateMany`, `@updatedAt` переставив би цей рядок
    // на «зараз» — і наступний мерж обрав би активну рецензію за адмінською
    // операцією, а не за тим, коли людина її редагувала.
    await expect(
      prisma.review.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } }),
    ).resolves.toEqual({ updatedAt: stamp })
  })

  it('R6: конфліктний вішлист — лишається ранішій, дублікат видаляється', async () => {
    const { source, target } = await twoWorks()
    const eager = await createUser(prisma, 'Хоче обидва')
    const single = await createUser(prisma, 'Хоче один')

    await prisma.wishlistItem.create({
      data: { userId: eager, workId: source, createdAt: new Date('2026-01-01T00:00:00Z') },
    })
    await prisma.wishlistItem.create({
      data: { userId: eager, workId: target, createdAt: new Date('2026-02-01T00:00:00Z') },
    })
    await prisma.wishlistItem.create({ data: { userId: single, workId: source } })

    const summary = await merge.merge(source, target)

    expect(summary.wishlistDuplicatesRemoved).toBe(1)

    const kept = await prisma.wishlistItem.findMany({
      where: { userId: eager },
      select: { workId: true, createdAt: true },
    })

    expect(kept).toEqual([{ workId: target, createdAt: new Date('2026-01-01T00:00:00Z') }])

    // Той, у кого конфлікту не було, просто переїхав.
    await expect(
      prisma.wishlistItem.count({ where: { userId: single, workId: target } }),
    ).resolves.toBe(1)
  })

  it('повторний мерж тієї самої пари відхиляється', async () => {
    const { source, target } = await twoWorks()

    await merge.merge(source, target)

    await expectRefusal(
      merge.merge(source, target),
      WORK_MERGE_ERROR_CODES.WORK_MERGE_SOURCE_ALREADY_MERGED,
    )
  })

  it('мерж уже змерженого твору кудись іще відхиляється — інакше виріс би ланцюг', async () => {
    const { source, target, ownerId } = await twoWorks()
    const third = await bareWork(ownerId)

    await merge.merge(source, target)

    await expectRefusal(
      merge.merge(source, third),
      WORK_MERGE_ERROR_CODES.WORK_MERGE_SOURCE_ALREADY_MERGED,
    )
  })

  it('мерж твору сам у себе відхиляється', async () => {
    const { source } = await twoWorks()

    await expectRefusal(merge.merge(source, source), WORK_MERGE_ERROR_CODES.WORK_MERGE_SELF)
  })

  it('R4: мерж у вже змержений твір відхиляється', async () => {
    const { source, target, ownerId } = await twoWorks()
    const third = await bareWork(ownerId)

    await merge.merge(source, target)

    await expectRefusal(
      merge.merge(third, source),
      WORK_MERGE_ERROR_CODES.WORK_MERGE_TARGET_ALREADY_MERGED,
    )
  })

  it('пряма спроба циклу A→B, потім B→A відхиляється', async () => {
    const { source: a, target: b } = await twoWorks()

    await merge.merge(a, b)

    await expectRefusal(merge.merge(b, a), WORK_MERGE_ERROR_CODES.WORK_MERGE_TARGET_ALREADY_MERGED)
  })

  it('R4: глибина розвʼязання лишається 1 — вхідні мержі переїжджають на нову ціль', async () => {
    const { source: a, target: b, ownerId } = await twoWorks()
    const c = await bareWork(ownerId)

    await merge.merge(a, b)

    const summary = await merge.merge(b, c)

    expect(summary.incomingMergesRepointed).toBe(1)

    // Ланцюга A→B→C не існує: A вказує одразу на C.
    const rows = await prisma.work.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true, mergedIntoId: true },
      orderBy: { id: 'asc' },
    })

    expect(rows.every((row) => row.mergedIntoId === c)).toBe(true)

    // Канонічний твір не вказує нікуди — саме він і є кінцем розвʼязання.
    await expect(
      prisma.work.findUnique({ where: { id: c }, select: { mergedIntoId: true } }),
    ).resolves.toEqual({ mergedIntoId: null })
  })

  it('неіснуючий твір відхиляється окремим кодом', async () => {
    const { source } = await twoWorks()

    await expectRefusal(
      merge.merge(source, 'work-that-never-was'),
      WORK_MERGE_ERROR_CODES.WORK_MERGE_WORK_NOT_FOUND,
    )
    await expectRefusal(
      merge.merge('work-that-never-was', source),
      WORK_MERGE_ERROR_CODES.WORK_MERGE_WORK_NOT_FOUND,
    )
  })

  /**
   * TD-06, first part: consolidating `WorkAuthor` during a merge.
   *
   * A link's identity is the pair (`authorId`, `role`) — the same one the
   * `WorkAuthor` PK uses in the schema. `Author` and the source `Work` are
   * never deleted here; what's checked is the `WorkAuthor` table itself and
   * what catalog reads actually see.
   */
  describe('TD-06: консолідація WorkAuthor при мержі', () => {
    let app: INestApplication
    let catalog: CatalogService

    beforeAll(async () => {
      // `createTestApp()` boots the real `AppModule` — the same DI graph that
      // wires `CatalogService` in production, with `BACKGROUND_MODE` disabled
      // (CLAUDE.md: never re-enable schedulers by hand-picking modules). This
      // gives the reading test below a genuine, DI-resolved `CatalogService`
      // instead of a hand-rolled copy of its Prisma projections.
      app = await createTestApp()
      catalog = app.get(CatalogService)
    })

    afterAll(async () => {
      await app.close()
    })

    it('різні автори source і target — обидва переїжджають на канонічний', async () => {
      const { source, target } = await twoWorks()
      const sourceAuthor = await createAuthor(`Автор джерела ${source}`)
      const targetAuthor = await createAuthor(`Автор цілі ${target}`)

      await linkAuthor(source, sourceAuthor, 'AUTHOR')
      await linkAuthor(target, targetAuthor, 'AUTHOR')

      const summary = await merge.merge(source, target)

      expect(summary.authorLinksMoved).toBe(1)
      expect(summary.authorLinksDuplicatesRemoved).toBe(0)

      const links = await authorLinks(target)

      expect(links).toEqual(
        expect.arrayContaining([
          { authorId: sourceAuthor, role: 'AUTHOR' },
          { authorId: targetAuthor, role: 'AUTHOR' },
        ]),
      )
      expect(links).toHaveLength(2)

      await expect(prisma.workAuthor.count({ where: { workId: source } })).resolves.toBe(0)
    })

    it('однакова пара authorId+role на обох — дубль не створюється', async () => {
      const { source, target } = await twoWorks()
      const shared = await createAuthor(`Спільний автор ${source}`)

      await linkAuthor(source, shared, 'AUTHOR')
      await linkAuthor(target, shared, 'AUTHOR')

      const summary = await merge.merge(source, target)

      expect(summary.authorLinksMoved).toBe(0)
      expect(summary.authorLinksDuplicatesRemoved).toBe(1)

      // One row on the target, not two: a plain `updateMany` would have hit
      // the PK `(workId, authorId, role)` head-on, so the duplicate was
      // simply never created.
      await expect(authorLinks(target)).resolves.toEqual([{ authorId: shared, role: 'AUTHOR' }])
      await expect(prisma.workAuthor.count({ where: { workId: source } })).resolves.toBe(0)
    })

    it('один authorId з різними ролями на source і target — обидві ролі зберігаються', async () => {
      const { source, target } = await twoWorks()
      const shared = await createAuthor(`Багаторольовий автор ${source}`)

      await linkAuthor(source, shared, 'AUTHOR')
      await linkAuthor(target, shared, 'ILLUSTRATOR')

      const summary = await merge.merge(source, target)

      expect(summary.authorLinksMoved).toBe(1)
      expect(summary.authorLinksDuplicatesRemoved).toBe(0)

      const links = await authorLinks(target)

      expect(links).toEqual(
        expect.arrayContaining([
          { authorId: shared, role: 'AUTHOR' },
          { authorId: shared, role: 'ILLUSTRATOR' },
        ]),
      )
      expect(links).toHaveLength(2)
    })

    it('різні authorId з однаковим імʼям лишаються різними авторами', async () => {
      const { source, target } = await twoWorks()
      const name = `Тезка ${source}`
      const sourceNamesake = await createAuthor(name)
      const targetNamesake = await createAuthor(name)

      await linkAuthor(source, sourceNamesake, 'AUTHOR')
      await linkAuthor(target, targetNamesake, 'AUTHOR')

      await merge.merge(source, target)

      const links = await authorLinks(target)

      expect(links.map((link) => link.authorId).sort()).toEqual(
        [sourceNamesake, targetNamesake].sort(),
      )

      // The merge does not deduplicate `Author` by name — namesakes stay two
      // separate rows even though their works just got merged.
      const authors = await prisma.author.findMany({
        where: { id: { in: [sourceNamesake, targetNamesake] } },
      })

      expect(authors).toHaveLength(2)
      expect(authors.every((author) => author.name === name)).toBe(true)
      expect(new Set(authors.map((author) => author.id)).size).toBe(2)
    })

    it('читання через CatalogService після мержу: автор видно на цілі, workCount правильний, джерело не рахується', async () => {
      const { source, target, ownerId } = await twoWorks()
      const another = await twoWorks()
      const shared = await createAuthor(`Автор кількох творів ${source}`)

      // The target deliberately doesn't have this author yet: this checks the
      // move itself, not deduplication.
      await linkAuthor(source, shared, 'AUTHOR')
      await linkAuthor(another.target, shared, 'AUTHOR')

      await merge.merge(source, target)

      // `getWork` is the same public method the `GET /api/v1/works/:id`
      // endpoint calls — not a re-implementation of its Prisma projection.
      // The moved author must show up on the target's own detail response.
      const detail = await catalog.getWork(ownerId, target)

      expect(detail.authors.map((author) => author.id)).toContain(shared)

      // `search` is the same public method behind `GET /api/v1/catalog/search`.
      // Its `authorMatches[].workCount` must count the target and the
      // independent third work — two — and must not count the merged source
      // as a separate book.
      const results = await catalog.search(`Автор кількох творів ${source}`, 1, 10)
      const match = results.authorMatches.find((author) => author.id === shared)

      expect(match?.workCount).toBe(2)
    })

    it('повний rollback при ін’єктованій помилці після зміни WorkAuthor', async () => {
      const { source, target } = await twoWorks()
      const sourceAuthor = await createAuthor(`Джерело до відкату ${source}`)
      const targetAuthor = await createAuthor(`Ціль до відкату ${target}`)

      await linkAuthor(source, sourceAuthor, 'AUTHOR')
      await linkAuthor(target, targetAuthor, 'AUTHOR')

      // `authorLinksByPosition`, not `authorLinks`: Stage 8e-1, R10a — a
      // rollback must not leave `position` half-consolidated even though it
      // isn't part of the link's identity (`authorId` + `role`).
      const beforeSource = await authorLinksByPosition(source)
      const beforeTarget = await authorLinksByPosition(target)
      const translationsOnSourceBefore = await prisma.translation.count({
        where: { workId: source },
      })

      // The extended client intercepts exactly the `work.update` call the
      // merge uses to close its transaction (setting `mergedIntoId` on the
      // source) — it runs last, right after the `WorkAuthor` consolidation
      // above. If this point doesn't roll back the author links, nothing
      // will.
      //
      // `xprisma` is handed to a fresh `MergeCliModule` context via
      // `overrideProvider(PrismaService).useValue(...)` — the same
      // provider-swap idiom `createTestApp()` already uses for
      // `BACKGROUND_MODE` and `ThrottlerGuard` (`auth.helpers.ts`). Nest's
      // own `useValue` accepts `any`, so `MergeService` gets a working
      // `PrismaService` without a cast anywhere in this file, and without
      // narrowing its constructor's parameter type in production code.
      const xprisma = prisma.$extends({
        query: {
          work: {
            async update({ args, query }) {
              if (args.where.id === source) {
                throw new Error('INJECTED_FAILURE_AFTER_AUTHOR_MOVE')
              }

              return query(args)
            },
          },
        },
      })

      const failingContext = await Test.createTestingModule({ imports: [MergeCliModule] })
        .overrideProvider(PrismaService)
        .useValue(xprisma)
        .compile()

      try {
        const failingMerge = failingContext.get(MergeService)

        await expect(failingMerge.merge(source, target)).rejects.toThrow(
          'INJECTED_FAILURE_AFTER_AUTHOR_MOVE',
        )
      } finally {
        await failingContext.close()
      }

      // WorkAuthor didn't move a single step — position included.
      await expect(authorLinksByPosition(source)).resolves.toEqual(beforeSource)
      await expect(authorLinksByPosition(target)).resolves.toEqual(beforeTarget)

      // Not just WorkAuthor — the whole transaction rolled back, the
      // translation stayed put too.
      await expect(prisma.translation.count({ where: { workId: source } })).resolves.toBe(
        translationsOnSourceBefore,
      )
      await expect(
        prisma.work.findUnique({ where: { id: source }, select: { mergedIntoId: true } }),
      ).resolves.toEqual({ mergedIntoId: null })
    })

    it('повторний мерж не змінює вже консолідовані звʼязки авторів', async () => {
      const { source, target } = await twoWorks()
      const sourceAuthor = await createAuthor(`Джерело idempotent ${source}`)
      const targetAuthor = await createAuthor(`Ціль idempotent ${target}`)

      await linkAuthor(source, sourceAuthor, 'AUTHOR')
      await linkAuthor(target, targetAuthor, 'AUTHOR')

      await merge.merge(source, target)

      // `authorLinksByPosition`: a rejected repeat merge must not touch
      // `position` either, even though it isn't part of the link's identity.
      const afterFirstMerge = await authorLinksByPosition(target)

      await expectRefusal(
        merge.merge(source, target),
        WORK_MERGE_ERROR_CODES.WORK_MERGE_SOURCE_ALREADY_MERGED,
      )

      // A rejected repeat merge is not a second consolidation pass: the
      // target's links — and their position — stay exactly as they came out
      // of the first merge.
      await expect(authorLinksByPosition(target)).resolves.toEqual(afterFirstMerge)
      await expect(prisma.workAuthor.count({ where: { workId: source } })).resolves.toBe(0)
    })

    /**
     * Stage 8e-1, R10a: злиття зберігає порядок цілі й дописує решту з джерела.
     *
     * Target: [X, Y] (position 0, 1). Source: [Y (дубль), Z] (position 0, 1).
     * Очікуваний результат: [X, Y, Z] з послідовними position 0, 1, 2 — X і Y
     * не зрушуються, Z дописується в кінець.
     */
    it('R10a: злиття лишає порядок target і дописує решту source в кінець', async () => {
      const { source, target } = await twoWorks()
      const x = await createAuthor(`X ${target}`)
      const y = await createAuthor(`Y ${target}`)
      const z = await createAuthor(`Z ${source}`)

      await linkAuthor(target, x, 'AUTHOR')
      await linkAuthor(target, y, 'AUTHOR')
      await linkAuthor(source, y, 'AUTHOR')
      await linkAuthor(source, z, 'AUTHOR')

      await merge.merge(source, target)

      await expect(authorLinksByPosition(target)).resolves.toEqual([
        { authorId: x, role: 'AUTHOR', position: 0 },
        { authorId: y, role: 'AUTHOR', position: 1 },
        { authorId: z, role: 'AUTHOR', position: 2 },
      ])
    })
  })
})
