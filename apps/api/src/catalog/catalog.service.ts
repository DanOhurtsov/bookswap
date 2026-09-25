import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  splitSearchPage,
  type AuthorMatch,
  type AuthorRole,
  type CatalogMatchKind,
  type CatalogSearchResponse,
  type CatalogSearchResult,
  type CreateEditionRequest,
  type CreateTranslationRequest,
  type CreateWorkRequest,
  type EditionDetailResponse,
  type EditionPatchResponse,
  type EditionResponse,
  type TranslationListResponse,
  type TranslationPatchResponse,
  type TranslationResponse,
  type WorkDetailResponse,
  type WorkPatchRequest,
  type WorkPatchResponse,
  type EditionPatchRequest,
  type TranslationPatchRequest,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { isUniqueViolation } from '../common/prisma-errors'
import { PrismaService } from '../prisma/prisma.service'
import { CanonicalWorkService, workMergedConflict } from './canonical/canonical-work.service'
import {
  byEditionOrder,
  toEdition,
  toEditionRevisionSnapshot,
  toTranslation,
  toTranslationRevisionSnapshot,
  toViewerCapabilities,
  toWork,
  toWorkAuthors,
  toWorkRevisionSnapshot,
} from './catalog.mapper'
import { LocalMatches } from './search/local-matches.service'
import { TextNormalizer } from './text-normalizer'

/** Проєкції, які повторюються в кількох запитах. Один опис — одна форма даних. */
const WITH_AUTHORS = {
  authors: { include: { author: true } },
} as const

const WITH_EDITIONS = {
  editions: { include: { translation: true } },
} as const

/**
 * Каталог (§6.3): спільні метадані `Work → Translation → Edition`.
 *
 * Примірників тут немає взагалі — ні в запитах, ні у відповідях. Каталог
 * однаковий для всіх, а хто чим володіє, живе в `LibraryService` і проходить
 * крізь матрицю §9. Змішати їх означало б віддавати чужі полиці з ендпоінта, у
 * якого немає поняття «хто питає».
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: TextNormalizer,
    private readonly canonical: CanonicalWorkService,
    private readonly local: LocalMatches,
  ) {}

  /**
   * §6.3, крок 1–2: «вводить назву або ISBN» → «Можливо, це одна з цих?».
   *
   * ISBN — окрема гілка з точним збігом: номер або той самий, або ні, і «схожий
   * ISBN» — це не схожа книжка, а інша книжка. Зовнішнього API тут немає
   * (§14.4) — шукаємо у власній базі.
   *
   * **Ранжування матеріалізується цілком** (`LocalMatches`, до 200 збігів), а
   * сторінка нарізається тут за `splitSearchPage`: локальна частина спільного
   * списку — це рядки `[localFrom, localFrom + localCount)`. Один індексований
   * запит дає і сторінку, і ТОЧНІ `total`/`hasMore` (перелічені рядки, а не
   * оцінка). Зовнішній ендпоінт рахує той самий `total` сам, тож обидві
   * половини узгоджено ділять сторінку, не чекаючи одна на одну.
   *
   * `docs/plan/stage-9-search-pagination.md` — чому саме так і де межі.
   */
  async search(query: string, page: number, pageSize: number): Promise<CatalogSearchResponse> {
    const matches = await this.local.rank(query, { authors: true })
    const total = matches.works.length
    const { localFrom, localCount } = splitSearchPage({ page, pageSize, localTotal: total })
    const pageRows = matches.works.slice(localFrom, localFrom + localCount)

    const matchKinds = new Map<string, CatalogMatchKind>(
      pageRows.map((row) => [
        row.id,
        matches.byIsbn ? 'ISBN' : row.titleScore >= row.authorScore ? 'TITLE' : 'AUTHOR',
      ]),
    )

    return {
      results: await this.hydrateWorks(
        pageRows.map((row) => row.id),
        (id) => matchKinds.get(id) ?? 'TITLE',
      ),
      authorMatches: await this.hydrateAuthors(matches.authors.map((row) => row.id)),
      page,
      pageSize,
      total,
      hasMore: total > page * pageSize,
    }
  }

  /**
   * `userId` powers `viewerCapabilities` (Stage 8e-2, R10) — the one extra
   * relation this needs (`editions.copies`, filtered to `userId`) rides along
   * on this same query, not a second lookup.
   */
  async getWork(userId: string, workId: string): Promise<WorkDetailResponse> {
    const work = await this.prisma.work.findUnique({
      where: { id: workId },
      include: {
        ...WITH_AUTHORS,
        translations: true,
        editions: {
          include: {
            translation: true,
            copies: { where: { ownerId: userId }, select: { id: true } },
          },
        },
      },
    })

    if (work === null) throw notFound('Твір не знайдено')

    const editionsPerTranslation = countEditionsPerTranslation(work.editions)

    return {
      work: toWork(work),
      authors: toWorkAuthors(work.authors),
      translations: sortTranslations(work.translations).map((translation) =>
        toTranslation(translation, editionsPerTranslation.get(translation.id) ?? 0),
      ),
      editions: work.editions.map((edition) => toEdition(edition, work)).sort(byEditionOrder),
      viewerCapabilities: toViewerCapabilities(userId, work),
    }
  }

  /** §8: «впорядковані за score, з ознаками». Порядок задає сервер, не клієнт. */
  async listTranslations(workId: string): Promise<TranslationListResponse> {
    const work = await this.prisma.work.findUnique({
      where: { id: workId },
      select: { id: true, translations: true, editions: { select: { translationId: true } } },
    })

    if (work === null) throw notFound('Твір не знайдено')

    const editionsPerTranslation = countEditionsPerTranslation(work.editions)

    return {
      translations: sortTranslations(work.translations).map((translation) =>
        toTranslation(translation, editionsPerTranslation.get(translation.id) ?? 0),
      ),
    }
  }

  async getEdition(editionId: string): Promise<EditionDetailResponse> {
    const edition = await this.prisma.edition.findUnique({
      where: { id: editionId },
      include: { translation: true, work: { include: WITH_AUTHORS } },
    })

    if (edition === null) throw notFound('Видання не знайдено')

    const editionCount = await this.prisma.edition.count({
      where: { translationId: edition.translationId },
    })

    return {
      edition: toEdition(edition, edition.work),
      work: toWork(edition.work),
      authors: toWorkAuthors(edition.work.authors),
      translation:
        edition.translation === null ? null : toTranslation(edition.translation, editionCount),
    }
  }

  /**
   * §6.3: метадані створює будь-хто автентифікований.
   *
   * Автор приходить або як `authorId` наявного, або як `name` нового — і ніколи
   * не підбирається за збігом імені. Тезки трапляються, і мовчки звести двох
   * людей в одну гірше, ніж лишити дублікат: дублікат видно й можна змерджити
   * (§6.3), а зрощені автори втрачають межу назавжди.
   */
  async createWork(userId: string, request: CreateWorkRequest): Promise<WorkDetailResponse> {
    const newNames = request.authors.flatMap((author) =>
      author.name === undefined ? [] : [author.name],
    )

    const workId = await this.prisma.$transaction(async (tx) => {
      const [titleNorm, ...nameNorms] = await this.normalizer.normalizeMany(
        [request.title, ...newNames],
        tx,
      )

      if (titleNorm === undefined) throw new Error('Нормалізація назви не повернула значення')

      await this.assertAuthorsExist(request.authors, tx)

      const work = await tx.work.create({
        data: {
          title: request.title,
          titleNorm,
          origLang: request.origLang,
          firstPubYear: request.firstPubYear ?? null,
          description: request.description ?? null,
          createdById: userId,
        },
      })

      let nextName = 0
      const links: { authorId: string; role: AuthorRole }[] = []

      for (const author of request.authors) {
        const role = author.role ?? 'AUTHOR'

        if (author.authorId !== undefined) {
          links.push({ authorId: author.authorId, role })
          continue
        }

        const nameNorm = nameNorms[nextName]

        nextName += 1

        if (author.name === undefined || nameNorm === undefined) {
          throw new Error('Нормалізація імені автора не повернула значення')
        }

        const created = await tx.author.create({
          data: { name: author.name, nameNorm, nameLatin: author.nameLatin ?? null },
        })

        links.push({ authorId: created.id, role })
      }

      // R10a: `position` йде за порядком елементів запиту, і дедуп мусить
      // статися ДО нумерації — інакше пропущена (бо дублікат) пара лишає дірку
      // в послідовності `0, 1, 2, …`. Раніше на це покладався `skipDuplicates`
      // у БД: та сама людина в тій самій ролі двічі — помилка заповнення форми,
      // не привід відхилити весь твір, — але робити це на рівні БД більше не
      // можна, бо позиція вже призначена рядку, який туди не потрапить.
      const deduped = dedupeAuthorLinks(links)

      await tx.workAuthor.createMany({
        data: deduped.map((link, position) => ({ workId: work.id, ...link, position })),
      })

      return work.id
    })

    return this.getWork(userId, workId)
  }

  async createTranslation(
    userId: string,
    workId: string,
    request: CreateTranslationRequest,
  ): Promise<TranslationResponse> {
    await this.canonical.assertCanonical(workId)

    const translation = await this.prisma.translation.create({
      data: {
        workId,
        translator: request.translator,
        lang: request.lang,
        sourceLang: request.sourceLang,
        year: request.year ?? null,
        isAbridged: request.isAbridged ?? false,
        hasNotes: request.hasNotes ?? false,
        notes: request.notes ?? null,
        createdById: userId,
      },
    })

    return { translation: toTranslation(translation, 0) }
  }

  async createEdition(
    userId: string,
    workId: string,
    request: CreateEditionRequest,
  ): Promise<EditionResponse> {
    const work = await this.prisma.work.findUnique({
      where: { id: workId },
      select: { id: true, origLang: true, mergedIntoId: true },
    })

    if (work === null) throw notFound('Твір не знайдено')

    // Stage 7h: `mergedIntoId` is read here rather than through
    // `CanonicalWorkService.assertCanonical` only to avoid a second lookup —
    // `origLang` is needed anyway. The rule and its reasoning live there.
    if (work.mergedIntoId !== null) {
      throw workMergedConflict({
        workId: work.mergedIntoId,
        requestedWorkId: workId,
        moved: true,
      })
    }

    const translationId = request.translationId ?? null

    if (translationId !== null) {
      const translation = await this.prisma.translation.findUnique({
        where: { id: translationId },
        select: { workId: true },
      })

      // Переклад чужого твору — не «не знайдено», а неможлива комбінація:
      // `Edition` посилається і на твір, і на переклад, і вони мусять збігатися.
      if (translation === null || translation.workId !== workId) {
        throw new ApiException(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Переклад не належить цьому твору',
          HttpStatus.BAD_REQUEST,
        )
      }
    }

    try {
      const edition = await this.prisma.edition.create({
        data: {
          workId,
          translationId,
          publisher: request.publisher ?? null,
          year: request.year ?? null,
          isbn13: request.isbn13 ?? null,
          pageCount: request.pageCount ?? null,
          coverUrl: request.coverUrl ?? null,
          format: request.format ?? 'PAPERBACK',
          createdById: userId,
        },
        include: { translation: true },
      })

      return { edition: toEdition(edition, work) }
    } catch (error) {
      if (isUniqueViolation(error) && request.isbn13 !== undefined && request.isbn13 !== null) {
        throw await this.isbnTaken(request.isbn13)
      }

      throw error
    }
  }

  /**
   * Stage 8e-2, R8/R9/R10a: Work metadata correction.
   *
   * `before` is read ONCE, under an explicit row lock, inside this
   * transaction — not by a separate pre-transaction `SELECT`, and not by a
   * conditional `UPDATE ... WHERE revision = $N` alone. Both would leave a gap
   * a concurrent `MergeService.merge()` can land in: `merge()` moves
   * `WorkAuthor` links onto a target and points a source at it via
   * `mergedIntoId`, WITHOUT ever bumping either side's `revision` (see
   * `merge.service.ts`). So a stale `mergedIntoId` check, or a revision-only
   * guard, cannot tell "this Work was just merged/consolidated" from "nothing
   * happened" — the write would either land silently on a now-merged Work, or
   * the audit `before` would describe authors that were never actually there
   * a moment before this PATCH's own change. The lock below is what actually
   * prevents both: `FOR UPDATE` is the SAME lock `MergeService.lockWorks`
   * takes on both sides of a merge, so this PATCH and a concurrent `merge()`
   * serialize against each other — whichever reaches the row first wins, the
   * other queues here until the first commits, and then reads the
   * POST-commit state, never a torn or stale one. This is also still the R8
   * "one permission query": the SAME locked read backs the merge check, the
   * ownership check, the revision check, and the audit snapshot.
   */
  async patchWork(
    userId: string,
    workId: string,
    request: WorkPatchRequest,
  ): Promise<WorkPatchResponse> {
    const newAuthorNames =
      request.authors === undefined
        ? []
        : request.authors.flatMap((author) => (author.name === undefined ? [] : [author.name]))

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${workId} FOR UPDATE`

      const before = await tx.work.findUnique({
        where: { id: workId },
        include: {
          ...WITH_AUTHORS,
          editions: {
            select: { id: true, copies: { where: { ownerId: userId }, select: { id: true } } },
          },
        },
      })

      if (before === null) throw notFound('Твір не знайдено')

      // R8: a write to a merged (non-canonical) Work is refused, same as
      // `createEdition`/`createTranslation` (`CanonicalWorkService`) — the
      // rule and its reasoning live there, not duplicated here. Checked here,
      // under the lock, not before this transaction opened.
      if (before.mergedIntoId !== null) {
        throw workMergedConflict({
          workId: before.mergedIntoId,
          requestedWorkId: workId,
          moved: true,
        })
      }

      const canEdit =
        before.createdById === userId ||
        before.editions.some((edition) => edition.copies.length > 0)

      if (!canEdit) throw forbidden()

      if (before.revision !== request.expectedRevision) {
        throw new ApiException(
          API_ERROR_CODES.CATALOG_REVISION_CONFLICT,
          'Твір змінено раніше — оновіть дані й спробуйте ще раз',
          HttpStatus.CONFLICT,
          { work: toWork(before), authors: toWorkAuthors(before.authors) },
        )
      }

      const titleNorm =
        request.title === undefined ? undefined : await this.normalizer.normalize(request.title, tx)

      await tx.work.update({
        where: { id: workId },
        data: {
          title: request.title,
          titleNorm,
          origLang: request.origLang,
          firstPubYear: request.firstPubYear,
          description: request.description,
          revision: { increment: 1 },
        },
      })

      // R10a: `authors` omitted — the link table is untouched. A supplied
      // array is a FULL replacement: existing `WorkAuthor` rows are dropped
      // and rebuilt from the submitted order, never the underlying `Author`
      // rows (R10 — this never renames or deletes a global `Author`).
      if (request.authors !== undefined) {
        await this.assertAuthorsExist(request.authors, tx)

        const nameNorms =
          newAuthorNames.length === 0 ? [] : await this.normalizer.normalizeMany(newAuthorNames, tx)

        let nextName = 0
        const links: { authorId: string; role: AuthorRole }[] = []

        for (const author of request.authors) {
          const role = author.role ?? 'AUTHOR'

          if (author.authorId !== undefined) {
            links.push({ authorId: author.authorId, role })
            continue
          }

          const nameNorm = nameNorms[nextName]

          nextName += 1

          if (author.name === undefined || nameNorm === undefined) {
            throw new Error('Нормалізація імені автора не повернула значення')
          }

          const created = await tx.author.create({
            data: { name: author.name, nameNorm, nameLatin: author.nameLatin ?? null },
          })

          links.push({ authorId: created.id, role })
        }

        // Same identity/dedup rule as `createWork` — no dedup by name, only an
        // exact repeated (authorId, role) pair, and only BEFORE `position` is
        // assigned (see `dedupeAuthorLinks`'s own comment).
        const deduped = dedupeAuthorLinks(links)

        await tx.workAuthor.deleteMany({ where: { workId } })
        await tx.workAuthor.createMany({
          data: deduped.map((link, position) => ({ workId, ...link, position })),
        })
      }

      const after = await tx.work.findUniqueOrThrow({
        where: { id: workId },
        include: WITH_AUTHORS,
      })

      // Same transaction as the update above (and the author replacement, if
      // any): a failure anywhere in this method rolls back the scalar change,
      // the author links, AND this audit row together — never a subset.
      await tx.catalogRevision.create({
        data: {
          entityType: 'WORK',
          entityId: workId,
          actorId: userId,
          before: toWorkRevisionSnapshot(before),
          after: toWorkRevisionSnapshot(after),
          fromRevision: before.revision,
          toRevision: after.revision,
        },
      })

      return { work: toWork(after), authors: toWorkAuthors(after.authors) }
    })
  }

  /**
   * Stage 8e-2, R8/R9: same locked-read shape as {@link patchWork} (without
   * the author list) — `before`, the ownership check, and the
   * `expectedRevision` check all come from the ONE read taken under `FOR
   * UPDATE`, inside this transaction, not a separate pre-transaction
   * `SELECT`. Nothing here moves a Translation across Works without also
   * touching `revision` (unlike `MergeService`'s effect on `Work`), so this
   * is defense in depth for consistency with `patchWork`/`patchEdition`
   * rather than a fix for a currently-reachable bug on this entity.
   */
  async patchTranslation(
    userId: string,
    translationId: string,
    request: TranslationPatchRequest,
  ): Promise<TranslationPatchResponse> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Translation" WHERE "id" = ${translationId} FOR UPDATE`

      const before = await tx.translation.findUnique({
        where: { id: translationId },
        include: {
          editions: {
            select: { id: true, copies: { where: { ownerId: userId }, select: { id: true } } },
          },
        },
      })

      if (before === null) throw notFound('Переклад не знайдено')

      const canEdit =
        before.createdById === userId ||
        before.editions.some((edition) => edition.copies.length > 0)

      if (!canEdit) throw forbidden()

      if (before.revision !== request.expectedRevision) {
        const editionCount = await tx.edition.count({ where: { translationId } })

        throw new ApiException(
          API_ERROR_CODES.CATALOG_REVISION_CONFLICT,
          'Переклад змінено раніше — оновіть дані й спробуйте ще раз',
          HttpStatus.CONFLICT,
          { translation: toTranslation(before, editionCount) },
        )
      }

      const after = await tx.translation.update({
        where: { id: translationId },
        data: {
          translator: request.translator,
          lang: request.lang,
          sourceLang: request.sourceLang,
          year: request.year,
          isAbridged: request.isAbridged,
          hasNotes: request.hasNotes,
          notes: request.notes,
          revision: { increment: 1 },
        },
      })

      await tx.catalogRevision.create({
        data: {
          entityType: 'TRANSLATION',
          entityId: translationId,
          actorId: userId,
          before: toTranslationRevisionSnapshot(before),
          after: toTranslationRevisionSnapshot(after),
          fromRevision: before.revision,
          toRevision: after.revision,
        },
      })

      const editionCount = await tx.edition.count({ where: { translationId } })

      return { translation: toTranslation(after, editionCount) }
    })
  }

  /**
   * Stage 8e-2, R8/R9/R10: Edition correction. Same locked-read shape as
   * {@link patchWork}/{@link patchTranslation} — `before`, the ownership
   * check, and the `expectedRevision` check share the ONE read taken under
   * `FOR UPDATE`. `translationId` keeps the same cross-Work rule as
   * `createEdition` (see the comment there); unique ISBN and merged-Work
   * semantics are unchanged — a merged Work's Editions moved to the target at
   * merge time (`MergeService`), so an Edition never actually belongs to a
   * non-canonical Work here, and holding this row's own lock means a
   * concurrent merge cannot move it out from under this transaction either.
   */
  async patchEdition(
    userId: string,
    editionId: string,
    request: EditionPatchRequest,
  ): Promise<EditionPatchResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Edition" WHERE "id" = ${editionId} FOR UPDATE`

        const before = await tx.edition.findUnique({
          where: { id: editionId },
          include: {
            work: { select: { id: true, origLang: true } },
            copies: { where: { ownerId: userId }, select: { id: true } },
            translation: true,
          },
        })

        if (before === null) throw notFound('Видання не знайдено')

        const canEdit = before.createdById === userId || before.copies.length > 0

        if (!canEdit) throw forbidden()

        if (request.translationId !== undefined && request.translationId !== null) {
          const translation = await tx.translation.findUnique({
            where: { id: request.translationId },
            select: { workId: true },
          })

          if (translation === null || translation.workId !== before.workId) {
            throw new ApiException(
              API_ERROR_CODES.VALIDATION_ERROR,
              'Переклад не належить цьому твору',
              HttpStatus.BAD_REQUEST,
            )
          }
        }

        if (before.revision !== request.expectedRevision) {
          throw new ApiException(
            API_ERROR_CODES.CATALOG_REVISION_CONFLICT,
            'Видання змінено раніше — оновіть дані й спробуйте ще раз',
            HttpStatus.CONFLICT,
            { edition: toEdition(before, before.work) },
          )
        }

        const after = await tx.edition.update({
          where: { id: editionId },
          data: {
            translationId: request.translationId,
            publisher: request.publisher,
            year: request.year,
            isbn13: request.isbn13,
            pageCount: request.pageCount,
            coverUrl: request.coverUrl,
            format: request.format,
            revision: { increment: 1 },
          },
          include: { translation: true },
        })

        await tx.catalogRevision.create({
          data: {
            entityType: 'EDITION',
            entityId: editionId,
            actorId: userId,
            before: toEditionRevisionSnapshot(before),
            after: toEditionRevisionSnapshot(after),
            fromRevision: before.revision,
            toRevision: after.revision,
          },
        })

        return { edition: toEdition(after, before.work) }
      })
    } catch (error) {
      if (isUniqueViolation(error) && request.isbn13 !== undefined && request.isbn13 !== null) {
        throw await this.isbnTaken(request.isbn13)
      }

      throw error
    }
  }

  /**
   * Ранжування віддає лише id — самі записи читаються типізовано.
   *
   * Порядок відновлюється за списком id, а не за тим, у якому їх повернув
   * `findMany`: `IN (...)` порядку не гарантує, і без цього кроку ранжування
   * пошуку просто зникало б.
   */
  private async hydrateWorks(
    ids: string[],
    matchedOn: (id: string) => CatalogMatchKind,
  ): Promise<CatalogSearchResult[]> {
    if (ids.length === 0) return []

    // `mergedIntoId: null` — DoD 7h: a merged work is never a search hit of its
    // own. `rankWorks` already filters it out; the ISBN branch reaches this
    // method through `Edition.workId`, which cannot belong to a merged work
    // either (writes are refused, and the merge moves editions along). Repeating
    // the condition here keeps the guarantee local to the query that returns
    // the rows, exactly as `SearchCandidatesService.hydrate` does.
    const works = await this.prisma.work.findMany({
      where: { id: { in: ids }, mergedIntoId: null },
      include: { ...WITH_AUTHORS, ...WITH_EDITIONS },
    })

    const byId = new Map(works.map((work) => [work.id, work]))

    return ids.flatMap((id) => {
      const work = byId.get(id)

      if (work === undefined) return []

      return [
        {
          work: toWork(work),
          authors: toWorkAuthors(work.authors),
          editions: work.editions.map((edition) => toEdition(edition, work)).sort(byEditionOrder),
          matchedOn: matchedOn(id),
        },
      ]
    })
  }

  private async hydrateAuthors(ids: string[]): Promise<AuthorMatch[]> {
    if (ids.length === 0) return []

    const authors = await this.prisma.author.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        nameLatin: true,
        // DoD 7h: merged works are not separate entries anywhere in the output,
        // and a count is an entry too. TD-06 has `MergeService` consolidate
        // `WorkAuthor` onto the canonical work, so this filter no longer earns
        // its keep against merges done from here on — it stays as a guard
        // against data merged before that fix, where a duplicate row could
        // still be sitting on the non-canonical work.
        works: { where: { work: { mergedIntoId: null } }, select: { workId: true } },
      },
    })

    const byId = new Map(authors.map((author) => [author.id, author]))

    return ids.flatMap((id) => {
      const author = byId.get(id)

      if (author === undefined) return []

      return [
        {
          id: author.id,
          name: author.name,
          nameLatin: author.nameLatin,
          // Через `Set`, а не `_count`: одна людина може бути в одного твору і
          // автором, і ілюстратором — це два рядки `WorkAuthor`, але один твір.
          workCount: new Set(author.works.map((link) => link.workId)).size,
        },
      ]
    })
  }

  private async assertAuthorsExist(
    authors: { authorId?: string }[],
    tx: Pick<PrismaService, 'author'>,
  ): Promise<void> {
    const ids = [
      ...new Set(
        authors.flatMap((author) => (author.authorId === undefined ? [] : [author.authorId])),
      ),
    ]

    if (ids.length === 0) return

    const found = await tx.author.count({ where: { id: { in: ids } } })

    if (found !== ids.length) throw notFound('Автора не знайдено')
  }

  /**
   * §8 вимагає машиночитний код, а тут ще й id зайнятого видання: клієнту
   * потрібна не помилка, а дорога до наявного запису, де лишається створити
   * тільки `Copy` (§6.3, крок 3).
   */
  private async isbnTaken(isbn13: string): Promise<ApiException> {
    const existing = await this.prisma.edition.findUnique({
      where: { isbn13 },
      select: { id: true },
    })

    return new ApiException(
      API_ERROR_CODES.EDITION_ISBN_TAKEN,
      'Видання з таким ISBN уже є в каталозі',
      HttpStatus.CONFLICT,
      existing === null ? undefined : { editionId: existing.id },
    )
  }
}

/**
 * §8: «впорядковані за score». `score` рахується §10 на етапі оцінок і поки
 * всюди нуль, тож другий ключ не косметика — без нього порядок був би довільним.
 */
function sortTranslations<T extends { score: number; year: number | null; id: string }>(
  translations: T[],
): T[] {
  return [...translations].sort(
    (one, other) =>
      other.score - one.score ||
      (one.year ?? Number.MAX_SAFE_INTEGER) - (other.year ?? Number.MAX_SAFE_INTEGER) ||
      one.id.localeCompare(other.id),
  )
}

/** §10.3: кількість видань цього перекладу — непрямий сигнал якості. */
function countEditionsPerTranslation(
  editions: { translationId: string | null }[],
): Map<string, number> {
  const counts = new Map<string, number>()

  for (const edition of editions) {
    if (edition.translationId === null) continue

    counts.set(edition.translationId, (counts.get(edition.translationId) ?? 0) + 1)
  }

  return counts
}

function notFound(message: string): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND)
}

/** Stage 8e-2, R8: creator or Copy-owner only — see `API_ERROR_CODES.CATALOG_EDIT_FORBIDDEN`. */
function forbidden(): ApiException {
  return new ApiException(
    API_ERROR_CODES.CATALOG_EDIT_FORBIDDEN,
    'Ви не можете редагувати цей запис каталогу',
    HttpStatus.FORBIDDEN,
  )
}

/**
 * R10a: identity of a `WorkAuthor` link is the pair (`authorId`, `role`) — same
 * key as the PK in `schema.prisma`. First occurrence wins and keeps its place
 * in the submitted order; a later duplicate is dropped before `position` is
 * assigned, not after — see the comment at the call site in `createWork`.
 */
function dedupeAuthorLinks(
  links: { authorId: string; role: AuthorRole }[],
): { authorId: string; role: AuthorRole }[] {
  const seen = new Set<string>()
  const deduped: { authorId: string; role: AuthorRole }[] = []

  for (const link of links) {
    const key = `${link.authorId}:${link.role}`

    if (seen.has(key)) continue

    seen.add(key)
    deduped.push(link)
  }

  return deduped
}
