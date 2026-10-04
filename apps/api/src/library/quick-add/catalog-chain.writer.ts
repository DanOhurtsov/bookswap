import { HttpStatus, Injectable } from '@nestjs/common'
import { API_ERROR_CODES, CATALOG_LIMITS, type QuickAddManualTarget } from '@bookswap/shared'
import { workMergedConflict } from '../../catalog/canonical/canonical-work.service'
import { lockWork } from '../../catalog/catalog-locks'
import { CatalogService } from '../../catalog/catalog.service'
import { resolveEditionText } from '../../catalog/edition-language'
import { textOrThrow } from '../../catalog/edition-language-errors'
import { TextNormalizer } from '../../catalog/text-normalizer'
import { ApiException } from '../../common/api.exception'
import type { Prisma } from '../../generated/prisma/client'
import type { PrismaService } from '../../prisma/prisma.service'
import type { ExternalMetadata } from './external-edition.resolver'

export type ChainClient = Pick<
  PrismaService,
  'author' | 'work' | 'workAuthor' | 'edition' | '$queryRaw'
>

/**
 * Створення ланцюга каталогу (Author → Work → WorkAuthor → Edition) з метаданих, які ПІДТВЕРДИВ провайдер
 * (docs/plan/fast-book-add.md, §5.3). Лише всередині транзакції викликача; мережі тут немає.
 *
 * Правила «не вигадувати»:
 * - мова оригіналу твору невідома (`origLang = null`), рік першого видання не виводиться з року видання;
 * - автори — як повідомило джерело, у тому ж порядку; жодного «Невідомий автор», коли їх немає;
 * - кожне ім'я — новий `Author`: збіг імені не є підставою для злиття (тезки трапляються);
 * - тип тексту — `UNKNOWN`, мова — мова ВИДАННЯ, якщо джерело її повідомило;
 * - формат — лише якщо джерело його сказало.
 */
@Injectable()
export class CatalogChainWriter {
  constructor(
    private readonly normalizer: TextNormalizer,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Ручне додавання (docs/plan/fast-book-add.md, §2.4): твір (наявний чи новий), необов'язковий переклад і
   * видання — у ТІЙ САМІЙ транзакції, що й `Copy`. Тип тексту й мова видання узгоджуються за правилами
   * `edition-language.ts`; суперечність — явна помилка й відкат усього.
   *
   * Порядок блокувань той самий, що скрізь: `Work` першим (наявний твір блокується, перевіряється канонічність).
   * ISBN, що вже є в каталозі, — `EDITION_ISBN_TAKEN` з `editionId`, щоб інтерфейс запропонував наявне видання.
   */
  async createManual(
    tx: Prisma.TransactionClient,
    userId: string,
    target: QuickAddManualTarget,
  ): Promise<string> {
    const { edition: input } = target

    if (input.isbn13 !== undefined && input.isbn13 !== null) {
      const taken = await tx.edition.findUnique({
        where: { isbn13: input.isbn13 },
        select: { id: true },
      })

      if (taken !== null) {
        throw new ApiException(
          API_ERROR_CODES.EDITION_ISBN_TAKEN,
          'Видання з таким ISBN уже є в каталозі',
          HttpStatus.CONFLICT,
          { editionId: taken.id },
        )
      }
    }

    let workId: string
    let workOrigLang: string | null

    if ('workId' in target.work) {
      workId = target.work.workId
      await lockWork(tx, workId)

      const work = await tx.work.findUnique({
        where: { id: workId },
        select: { origLang: true, mergedIntoId: true },
      })

      if (work === null) {
        throw new ApiException(API_ERROR_CODES.NOT_FOUND, 'Твір не знайдено', HttpStatus.NOT_FOUND)
      }

      if (work.mergedIntoId !== null) {
        throw workMergedConflict({
          workId: work.mergedIntoId,
          requestedWorkId: workId,
          moved: true,
        })
      }

      workOrigLang = work.origLang
    } else {
      // Новий твір: мова оригіналу — лише та, яку людина сказала, або мова видання, яке вона ЯВНО назвала
      // оригіналом. Інакше вона лишається невідомою; ніщо не вгадується.
      workOrigLang =
        target.work.origLang ?? (input.textKind === 'ORIGINAL' ? (input.lang ?? null) : null)
      workId = await this.catalog.createWorkIn(tx, userId, {
        ...target.work,
        origLang: workOrigLang,
      })
    }

    let translationId: string | undefined

    if (target.translation !== undefined) {
      const translation = await tx.translation.create({
        data: {
          workId,
          translator: target.translation.translator,
          lang: target.translation.lang,
          sourceLang: target.translation.sourceLang,
          year: target.translation.year ?? null,
          isAbridged: target.translation.isAbridged ?? false,
          hasNotes: target.translation.hasNotes ?? false,
          notes: target.translation.notes ?? null,
          createdById: userId,
        },
      })

      translationId = translation.id
    }

    const text = textOrThrow(
      resolveEditionText(
        undefined,
        {
          textKind: input.textKind,
          ...(input.lang === undefined ? {} : { lang: input.lang }),
          ...(translationId === undefined ? {} : { translationId }),
        },
        {
          workOrigLang,
          ...(target.translation === undefined
            ? {}
            : { targetTranslation: { lang: target.translation.lang } }),
        },
      ),
    )

    const edition = await tx.edition.create({
      data: {
        workId,
        translationId: text.translationId,
        textKind: text.textKind,
        lang: text.lang,
        publisher: input.publisher ?? null,
        year: input.year ?? null,
        isbn13: input.isbn13 ?? null,
        pageCount: input.pageCount ?? null,
        coverUrl: input.coverUrl ?? null,
        format: input.format ?? null,
        createdById: userId,
      },
    })

    return edition.id
  }

  async createFromExternal(
    tx: ChainClient,
    userId: string,
    input: { metadata: ExternalMetadata; isbn13?: string | undefined },
  ): Promise<string> {
    const { metadata } = input
    const title = metadata.title.trim().slice(0, CATALOG_LIMITS.titleMax)
    const names = [
      ...new Set(
        metadata.authors.map((name) => name.trim().slice(0, CATALOG_LIMITS.authorNameMax)),
      ),
    ]
      .filter((name) => name !== '')
      .slice(0, CATALOG_LIMITS.authorsMax)
    const [titleNorm, ...nameNorms] = await this.normalizer.normalizeMany([title, ...names], tx)

    if (titleNorm === undefined) throw new Error('Нормалізація назви не повернула значення')

    const work = await tx.work.create({
      data: {
        title,
        titleNorm,
        origLang: null,
        firstPubYear: null,
        description:
          metadata.description === undefined
            ? null
            : metadata.description.slice(0, CATALOG_LIMITS.descriptionMax),
        createdById: userId,
      },
    })

    for (const [position, name] of names.entries()) {
      const nameNorm = nameNorms[position]

      if (nameNorm === undefined) throw new Error('Нормалізація імені автора не повернула значення')

      const author = await tx.author.create({ data: { name, nameNorm, nameLatin: null } })

      await tx.workAuthor.create({
        data: { workId: work.id, authorId: author.id, role: 'AUTHOR', position },
      })
    }

    const edition = await tx.edition.create({
      data: {
        workId: work.id,
        translationId: null,
        textKind: 'UNKNOWN',
        lang: metadata.language ?? null,
        publisher: metadata.publisher?.slice(0, CATALOG_LIMITS.publisherMax) ?? null,
        year: inRange(metadata.publishedYear, CATALOG_LIMITS.yearMin, CATALOG_LIMITS.yearMax),
        isbn13: input.isbn13 ?? null,
        pageCount: inRange(metadata.pageCount, 1, CATALOG_LIMITS.pageCountMax),
        coverUrl:
          metadata.coverUrl !== undefined && metadata.coverUrl.length <= CATALOG_LIMITS.coverUrlMax
            ? metadata.coverUrl
            : null,
        format: metadata.format ?? null,
        createdById: userId,
      },
    })

    return edition.id
  }
}

/** Значення поза допустимою межею — це «невідомо», а не обрізане число. */
function inRange(value: number | undefined, min: number, max: number): number | null {
  return value !== undefined && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}
