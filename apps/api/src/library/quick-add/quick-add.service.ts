import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type QuickAddExternalEditionTarget,
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
  'LibraryAddOperation_userId_operationId_key',
] as const

const MAX_ATTEMPTS = 2

interface Outcome {
  response: QuickAddResponse
  copyId: string
}

/** Що відомо про зовнішнє видання ДО транзакції: або воно вже наше (мережі не було), або підтверджене джерелом. */
interface PreparedExternal {
  confirmed?: ConfirmedExternalEdition
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
    private readonly chain: CatalogChainWriter,
  ) {}

  async add(userId: string, request: QuickAddRequest): Promise<QuickAddResponse> {
    const requestHash = requestHashOf(request)
    const prepared = await this.prepare(userId, request)
    const outcome = await this.transact(userId, request, requestHash, prepared)

    await this.afterCommit(userId, outcome.copyId, request.entryMethod ?? 'MANUAL')

    return outcome.response
  }

  /** Мережа — до транзакції й лише коли вона справді потрібна: не для повтору й не для вже відомого видання. */
  private async prepare(userId: string, request: QuickAddRequest): Promise<PreparedExternal> {
    const { target } = request

    if (target.kind !== 'EXTERNAL_EDITION') return {}

    const repeated = await this.prisma.libraryAddOperation.findUnique({
      where: { userId_operationId: { userId, operationId: request.operationId } },
      select: { id: true },
    })

    // Повтор виконаної дії: транзакція сама поверне результат або поверне пояснення конфлікту — провайдер не потрібен.
    if (repeated !== null) return {}

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
    const editionId =
      target.kind === 'EXISTING_EDITION'
        ? await this.existingEditionId(tx, target.editionId)
        : target.kind === 'MANUAL'
          ? await this.chain.createManual(tx, userId, target)
          : await this.externalEditionId(tx, userId, target, prepared)

    const copy = await this.copies.create(tx, {
      ownerId: userId,
      editionId,
      values: request.copy ?? {},
    })

    return { copy, targetKind: target.kind }
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
      if (confirmed?.reference !== undefined && !found.referenceKnown) {
        await this.rememberReference(tx, found.editionId, confirmed.reference)
      }

      return found.editionId
    }

    if (confirmed === undefined) {
      // Видання, яке щойно було відоме, зникло: каталог нічого не видаляє, тож це неможливо без втручання.
      throw new Error('Зовнішнє видання не знайдено локально й не було підтверджене джерелом')
    }

    const editionId = await this.chain.createFromExternal(tx, userId, {
      metadata: confirmed.metadata,
      isbn13: confirmed.isbn13,
    })

    if (confirmed.reference !== undefined) {
      await this.rememberReference(tx, editionId, confirmed.reference)
    }

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
