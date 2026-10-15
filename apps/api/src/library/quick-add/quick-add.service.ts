import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type QuickAddExternalEditionTarget,
  type QuickAddExternalWorkTarget,
  type QuickAddManualTarget,
  type QuickAddRequest,
  type QuickAddResponse,
  type QuickAddTargetKind,
} from '@bookswap/shared'
import { AnalyticsService } from '../../analytics/analytics.service'
import { NetworkActivationService } from '../../analytics/network-activation.service'
import { ApiException } from '../../common/api.exception'
import { isUniqueViolationOn } from '../../common/prisma-errors'
import { toEdition, toWork, toWorkAuthors } from '../../catalog/catalog.mapper'
import { PrismaService } from '../../prisma/prisma.service'
import { CopyWriter } from '../copy-writer'
import { WITH_CATALOG } from '../library-includes'
import { toOwnCopy } from '../library.mapper'
import { CatalogChainWriter } from './catalog-chain.writer'
import {
  ExternalEditionResolver,
  type ConfirmedExternalEdition,
  type ExternalReferenceKey,
} from './external-edition.resolver'
import {
  editionFromSource,
  editionOfWorkRecord,
  needsWorkSource,
  originalLanguageOf,
} from './external-details'
import { ExternalWorkResolver, type ConfirmedExternalWork } from './external-work.resolver'
import { requestHashOf } from './quick-add.hash'
import type { Prisma } from '../../generated/prisma/client'

type CopyWithCatalog = Awaited<ReturnType<CopyWriter['create']>>

/** Транзакція швидкого додавання: фіксований короткий набір запитів, мережі всередині немає. */
const TRANSACTION_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const

/**
 * Очікувані конфлікти змагання, після яких ОДИН повтор усієї транзакції дає правильну відповідь: той, хто
 * виграв, уже створив видання чи посилання, і тепер вони знаходяться, а не створюються. Нічого іншого не
 * повторюється.
 */
const RACE_CONSTRAINTS = [
  'Edition_isbn13_key',
  'EditionExternalReference_source_externalId_key',
  'WorkExternalReference_source_externalId_key',
  'LibraryAddOperation_userId_operationId_key',
] as const

const MAX_ATTEMPTS = 2

interface Outcome {
  response: QuickAddResponse
  copyId: string
}

/** Що відомо про зовнішній запис ДО транзакції: або він уже наш (мережі не було), або підтверджений джерелом. */
interface PreparedExternal {
  confirmed?: ConfirmedExternalEdition
  work?: ConfirmedExternalWork
}

type ExternalTarget = QuickAddExternalEditionTarget | QuickAddExternalWorkTarget

/** «Уточнити дані» (BS-114): людина додала до зовнішнього запису поля видання чи переклад. */
function hasDetails(target: ExternalTarget): boolean {
  return target.edition !== undefined || target.translation !== undefined
}

/**
 * `POST /me/library/quick-add` (docs/plan/fast-book-add.md, §5).
 *
 * Ідемпотентність тримає база, а не пам'ять процесу: після рестарту й між інстансами повтор
 * того самого `operationId` теж віддає той самий примірник.
 *
 * Порядок:
 * 0. Для зовнішнього видання, ДО транзакції: спершу локальна ідентичність (ISBN, посилання) — знайшли, і мережі
 *    немає; інакше метадані й підтверджена пара беруться у провайдера.
 * 1. `pg_advisory_xact_lock` на (користувач, `operationId`) — одночасні дублікати стають у чергу.
 * 2. Є запис операції → повтор: інший відбиток запиту — 409, видалений результат — 409, інакше наявний примірник.
 * 3. Немає → у ТІЙ САМІЙ транзакції: (за потреби) ланцюг каталогу, посилання, `Copy` і запис операції. Будь-яка
 *    помилка відкочує все.
 *
 * Аналітика й мережеві події — лише після commit, і їхній збій не перетворюється на помилку
 * додавання. Вони best-effort: replay дозаписує те, чого бракує (дедуплікація за `copyId`).
 */
@Injectable()
export class QuickAddService {
  private readonly logger = new Logger(QuickAddService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly network: NetworkActivationService,
    private readonly copies: CopyWriter,
    private readonly external: ExternalEditionResolver,
    private readonly works: ExternalWorkResolver,
    private readonly chain: CatalogChainWriter,
  ) {}

  async add(userId: string, request: QuickAddRequest): Promise<QuickAddResponse> {
    const requestHash = requestHashOf(request)
    const prepared = await this.prepare(userId, request)
    const outcome = await this.transact(userId, request, requestHash, prepared)

    await this.afterCommit(userId, outcome.copyId, request.entryMethod ?? 'MANUAL')

    return outcome.response
  }

  /** Мережа — до транзакції й лише коли вона справді потрібна: не для повтору й не для вже відомого запису. */
  private async prepare(userId: string, request: QuickAddRequest): Promise<PreparedExternal> {
    const { target } = request

    if (target.kind !== 'EXTERNAL_EDITION' && target.kind !== 'EXTERNAL_WORK') return {}

    const repeated = await this.prisma.libraryAddOperation.findUnique({
      where: { userId_operationId: { userId, operationId: request.operationId } },
      select: { id: true },
    })

    // Повтор виконаної дії: транзакція сама поверне результат або поверне пояснення конфлікту — провайдер не потрібен.
    if (repeated !== null) return {}

    if (target.kind === 'EXTERNAL_WORK') {
      const key = ExternalWorkResolver.keyOf(target)
      const known = await this.works.findLocal(this.prisma, key)

      return needsWorkSource(target, known) ? { work: await this.works.fetch(key) } : {}
    }

    const known = await this.external.findLocal(
      this.prisma,
      ExternalEditionResolver.namedBy(target),
    )

    // Видання вже наше: додавання не залежить від провайдера.
    if (known.editionId !== undefined) return {}

    return { confirmed: await this.external.fetch(target) }
  }

  private async transact(
    userId: string,
    request: QuickAddRequest,
    requestHash: string,
    prepared: PreparedExternal,
  ): Promise<Outcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.run(tx, userId, request, requestHash, prepared),
          TRANSACTION_OPTIONS,
        )
      } catch (error) {
        const raced = RACE_CONSTRAINTS.some((constraint) => isUniqueViolationOn(error, constraint))

        if (!raced || attempt >= MAX_ATTEMPTS) throw error
      }
    }
  }

  private async run(
    tx: Prisma.TransactionClient,
    userId: string,
    request: QuickAddRequest,
    requestHash: string,
    prepared: PreparedExternal,
  ): Promise<Outcome> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-add:${userId}:${request.operationId}`}))`

    const earlier = await tx.libraryAddOperation.findUnique({
      where: { userId_operationId: { userId, operationId: request.operationId } },
    })

    if (earlier !== null) return this.replay(tx, userId, request, requestHash, earlier)

    const { copy, targetKind } = await this.createFromTarget(tx, userId, request, prepared)

    await tx.libraryAddOperation.create({
      data: {
        userId,
        operationId: request.operationId,
        requestHash,
        targetKind,
        editionId: copy.editionId,
        copyId: copy.id,
      },
    })

    return { copyId: copy.id, response: toResponse(request.operationId, false, copy) }
  }

  private async replay(
    tx: Prisma.TransactionClient,
    userId: string,
    request: QuickAddRequest,
    requestHash: string,
    earlier: { requestHash: string; copyId: string | null },
  ): Promise<Outcome> {
    if (earlier.requestHash !== requestHash) {
      throw new ApiException(
        API_ERROR_CODES.LIBRARY_ADD_OPERATION_CONFLICT,
        'Цей operationId уже використано для іншого запиту',
        HttpStatus.CONFLICT,
      )
    }

    const copy =
      earlier.copyId === null
        ? null
        : await tx.copy.findFirst({
            where: { id: earlier.copyId, ownerId: userId },
            include: WITH_CATALOG,
          })

    if (copy === null) {
      throw new ApiException(
        API_ERROR_CODES.LIBRARY_ADD_RESULT_REMOVED,
        'Примірник, створений цією операцією, уже видалено — почніть нове додавання',
        HttpStatus.CONFLICT,
      )
    }

    return { copyId: copy.id, response: toResponse(request.operationId, true, copy) }
  }

  private async createFromTarget(
    tx: Prisma.TransactionClient,
    userId: string,
    request: QuickAddRequest,
    prepared: PreparedExternal,
  ): Promise<{ copy: CopyWithCatalog; targetKind: QuickAddTargetKind }> {
    const { target } = request
    const editionId = await this.editionIdFor(tx, userId, target, prepared)

    const copy = await this.copies.create(tx, {
      ownerId: userId,
      editionId,
      values: request.copy ?? {},
    })

    return { copy, targetKind: target.kind }
  }

  private async editionIdFor(
    tx: Prisma.TransactionClient,
    userId: string,
    target: QuickAddRequest['target'],
    prepared: PreparedExternal,
  ): Promise<string> {
    switch (target.kind) {
      case 'EXISTING_EDITION':
        return this.existingEditionId(tx, target.editionId)
      case 'MANUAL':
        return this.chain.createManual(tx, userId, target)
      case 'EXTERNAL_EDITION':
        return this.externalEditionId(tx, userId, target, prepared)
      case 'EXTERNAL_WORK':
        return this.externalWorkEditionId(tx, userId, target, prepared.work)
    }
  }

  private async existingEditionId(
    tx: Prisma.TransactionClient,
    editionId: string,
  ): Promise<string> {
    const edition = await tx.edition.findUnique({ where: { id: editionId }, select: { id: true } })

    if (edition === null) {
      throw new ApiException(API_ERROR_CODES.NOT_FOUND, 'Видання не знайдено', HttpStatus.NOT_FOUND)
    }

    return edition.id
  }

  /**
   * Видання за ISBN чи посиланням (свіжо, під блокуванням операції) або нове з підтверджених метаданих.
   *
   * Посилання пишеться ЛИШЕ з підтвердженої джерелом пари, і лише коли його ще немає; після `ON CONFLICT DO
   * NOTHING` перевіряється, що воно вказує на очікуване видання, — інакше це явний конфлікт і відкат усього.
   */
  private async externalEditionId(
    tx: Prisma.TransactionClient,
    userId: string,
    target: QuickAddExternalEditionTarget,
    prepared: PreparedExternal,
  ): Promise<string> {
    const { confirmed } = prepared
    // Те, що відомо підтверджено, має перевагу; інакше — лише назване клієнтом, і лише для ПОШУКУ наявного.
    const identity =
      confirmed === undefined
        ? ExternalEditionResolver.namedBy(target)
        : { isbn13: confirmed.isbn13, reference: confirmed.reference }
    const found = await this.external.findLocal(tx, identity)

    if (found.editionId !== undefined) {
      // Уточнення не дописується в чуже спільне видання мовчки: людина бачить наявне й додає його як є.
      if (hasDetails(target)) throw editionAlreadyInCatalog(found.editionId)

      if (confirmed?.reference !== undefined && !found.referenceKnown) {
        await this.rememberReference(tx, found.editionId, confirmed.reference)
      }

      return found.editionId
    }

    if (confirmed === undefined) {
      // Видання, яке щойно було відоме, зникло: каталог нічого не видаляє, тож це неможливо без втручання.
      throw new Error('Зовнішнє видання не знайдено локально й не було підтверджене джерелом')
    }

    const editionId = hasDetails(target)
      ? await this.createRefinedEdition(tx, userId, target, confirmed)
      : await this.chain.createFromExternal(tx, userId, {
          metadata: confirmed.metadata,
          isbn13: confirmed.isbn13,
        })

    if (confirmed.reference !== undefined) {
      await this.rememberReference(tx, editionId, confirmed.reference)
    }

    return editionId
  }

  /**
   * «Уточнити дані» зовнішнього видання (BS-114): твір — з підтвердженого джерелом, видання — підтверджене
   * джерелом із доданим людиною на місці прогалин (`editionFromSource`). Переклад, тип тексту й ISBN, що вже є
   * в каталозі, проходять ті самі правила, що й ручна форма.
   */
  private async createRefinedEdition(
    tx: Prisma.TransactionClient,
    userId: string,
    target: QuickAddExternalEditionTarget,
    confirmed: ConfirmedExternalEdition,
  ): Promise<string> {
    const edition = editionFromSource(confirmed, target.edition)
    const workId = await this.chain.createWorkFromSource(tx, userId, {
      title: confirmed.metadata.title,
      authors: confirmed.metadata.authors,
      description: confirmed.metadata.description,
      origLang: originalLanguageOf(edition),
    })

    return this.chain.createManual(tx, userId, manualOn(workId, edition, target.translation))
  }

  /**
   * Запис ТВОРУ (BS-114). Під advisory-блокуванням запису (два перші додавання не створять двох творів)
   * підтверджене посилання веде до НАШОГО твору; без нього твір створюється з відповіді джерела й посилання
   * записується. Пряме додавання потрапляє на видання «без уточнення» цього запису — знаходить наявне, а не
   * створює ще одне; уточнене — нове видання того самого твору з даними людини.
   *
   * Назва чи автор, що просто збігаються, нічого не зв'язують: лише посилання.
   */
  private async externalWorkEditionId(
    tx: Prisma.TransactionClient,
    userId: string,
    target: QuickAddExternalWorkTarget,
    confirmed: ConfirmedExternalWork | undefined,
  ): Promise<string> {
    const key = ExternalWorkResolver.keyOf(target)

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-add-work:${key.source}:${key.externalId}`}))`

    const known = await this.works.findLocal(tx, key)

    if (needsWorkSource(target, known) && confirmed === undefined) {
      // `prepare` питав джерело щоразу, коли воно потрібне; посилання й видання не зникають — без втручання це неможливо.
      throw new Error('Запис твору потребує відповіді джерела, але її не отримано')
    }

    let workId: string

    if (known === null) {
      if (confirmed === undefined) throw new Error('Новий твір без підтверджених метаданих')

      workId = await this.chain.createWorkFromSource(tx, userId, {
        title: confirmed.title,
        authors: confirmed.authors,
        firstPubYear: confirmed.firstPubYear,
      })
      await tx.workExternalReference.create({ data: { ...key, workId } })
    } else {
      workId = await canonicalWorkId(tx, known.workId)
    }

    if (hasDetails(target)) {
      return this.chain.createManual(
        tx,
        userId,
        manualOn(
          workId,
          editionOfWorkRecord(target.edition, confirmed?.coverUrl),
          target.translation,
        ),
      )
    }

    if (known !== null && known.editionId !== null) return known.editionId

    const editionId = await this.chain.createUnspecifiedEdition(tx, userId, {
      workId,
      coverUrl: confirmed?.coverUrl,
    })

    await tx.workExternalReference.update({
      where: { source_externalId: key },
      data: { editionId },
    })

    return editionId
  }

  private async rememberReference(
    tx: Prisma.TransactionClient,
    editionId: string,
    reference: ExternalReferenceKey,
  ): Promise<void> {
    await tx.editionExternalReference.createMany({
      data: [{ ...reference, editionId }],
      skipDuplicates: true,
    })

    const stored = await tx.editionExternalReference.findUniqueOrThrow({
      where: { source_externalId: reference },
      select: { editionId: true },
    })

    if (stored.editionId !== editionId) {
      throw new ApiException(
        API_ERROR_CODES.EXTERNAL_IDENTITY_CONFLICT,
        'Зовнішнє посилання вже належить іншому виданню — примірник не створено',
        HttpStatus.CONFLICT,
        { referenceEditionId: stored.editionId, expectedEditionId: editionId },
      )
    }
  }

  /**
   * Лише після commit. `record` і `onInventoryAdded` самі ковтають помилки; обгортка тут —
   * друга лінія: ніщо після commit не має права перетворити збережений примірник на
   * «додавання не вдалося». Лог без ID й без вмісту.
   */
  private async afterCommit(
    userId: string,
    copyId: string,
    method: 'MANUAL' | 'BARCODE',
  ): Promise<void> {
    try {
      await this.analytics.record({
        type: 'BOOK_ADDED',
        subjectUserId: userId,
        domainEntityId: copyId,
        properties: { method },
      })
      await this.network.onInventoryAdded(userId)
    } catch {
      this.logger.warn('Післязаписні дії швидкого додавання не виконано; примірник збережено')
    }
  }
}

/** Злитий твір відповідає своїм канонічним (інваріант R4: один крок, ланцюгів немає). */
async function canonicalWorkId(tx: Prisma.TransactionClient, workId: string): Promise<string> {
  const work = await tx.work.findUnique({ where: { id: workId }, select: { mergedIntoId: true } })

  return work?.mergedIntoId ?? workId
}

function manualOn(
  workId: string,
  edition: QuickAddManualTarget['edition'],
  translation: QuickAddManualTarget['translation'],
): QuickAddManualTarget {
  return {
    kind: 'MANUAL',
    work: { workId },
    edition,
    ...(translation === undefined ? {} : { translation }),
  }
}

function editionAlreadyInCatalog(editionId: string): ApiException {
  return new ApiException(
    API_ERROR_CODES.EDITION_ISBN_TAKEN,
    'Це видання вже є в каталозі',
    HttpStatus.CONFLICT,
    { editionId },
  )
}

function toResponse(
  operationId: string,
  replayed: boolean,
  copy: CopyWithCatalog,
): QuickAddResponse {
  const { edition } = copy

  return {
    operationId,
    replayed,
    copy: toOwnCopy(copy),
    edition: toEdition(edition),
    work: toWork(edition.work),
    authors: toWorkAuthors(edition.work.authors),
  }
}
