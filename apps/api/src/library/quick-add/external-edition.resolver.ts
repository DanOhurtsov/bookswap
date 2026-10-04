import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  isLanguageCode,
  normalizeIsbn13,
  type BookLookupResult,
  type QuickAddExternalEditionTarget,
} from '@bookswap/shared'
import { LookupService } from '../../catalog/lookup/lookup.service'
import { BookLookupProviderError } from '../../catalog/lookup/book-lookup-provider'
import { lookupTimeoutMs } from '../../catalog/lookup/lookup.config'
import { runWithTimeout } from '../../catalog/lookup/lookup-timeout'
import {
  EXTERNAL_VOLUME_PROVIDER,
  type ExternalVolumeProvider,
} from '../../catalog/lookup/google-books-volume-provider'
import { ApiException } from '../../common/api.exception'
import type { ExternalBookSource } from '../../generated/prisma/enums'
import type { PrismaService } from '../../prisma/prisma.service'

/**
 * Зовнішня ідентичність видання, яку ПІДТВЕРДИВ сам провайдер: його відповідь, а не слова клієнта.
 * Лише з такої пари дозволено створити `EditionExternalReference`.
 */
export interface ExternalReferenceKey {
  source: ExternalBookSource
  externalId: string
}

/** Метадані, які провайдер повідомив про видання. Нічого не вигадується: відсутнє — відсутнє. */
export interface ExternalMetadata {
  title: string
  authors: string[]
  publishedYear?: number
  language?: string
  publisher?: string
  description?: string
  pageCount?: number
  format?: BookLookupResult['format']
  coverUrl?: string
}

export interface ConfirmedExternalEdition {
  /** ISBN-13 САМОГО видання за відповіддю провайдера (або за точним збігом ISBN при пошуку за ним). */
  isbn13?: string
  reference?: ExternalReferenceKey
  metadata: ExternalMetadata
}

type LocalClient = Pick<PrismaService, 'edition' | 'editionExternalReference'>

export interface LocalIdentity {
  isbn13?: string | undefined
  reference?: ExternalReferenceKey | undefined
}

export interface LocalResolution {
  editionId: string | undefined
  /** Посилання вже є в БД (воно не створюється вдруге й не переприв'язується). */
  referenceKnown: boolean
}

function identityConflict(details: Record<string, string>): ApiException {
  return new ApiException(
    API_ERROR_CODES.EXTERNAL_IDENTITY_CONFLICT,
    'ISBN і зовнішнє посилання вказують на різні видання — примірник не створено',
    HttpStatus.CONFLICT,
    details,
  )
}

/**
 * Ідентичність зовнішнього видання (docs/plan/fast-book-add.md, §5.3; ред. 2.1).
 *
 * Два етапи, і порядок важливий:
 * 1. `findLocal` — лише БД: точний ISBN і підтверджене зовнішнє посилання. Знайшли — видання вже наше, і
 *    додавання НЕ залежить від доступності провайдера.
 * 2. `fetch` — мережа, ДО транзакції: метадані й підтверджена пара беруться у джерела. Довільний URL чи метадані
 *    клієнта не використовуються.
 *
 * ISBN і посилання, що вказують на РІЗНІ видання, — явний конфлікт (`EXTERNAL_IDENTITY_CONFLICT`): нічого не
 * створюється й не переприв'язується.
 */
@Injectable()
export class ExternalEditionResolver {
  constructor(
    private readonly lookup: LookupService,
    @Inject(EXTERNAL_VOLUME_PROVIDER) private readonly volumes: ExternalVolumeProvider,
  ) {}

  /** Ідентичність, яку клієнт НАЗВАВ (для пошуку наявного); створювати з неї посилання не можна. */
  static namedBy(target: QuickAddExternalEditionTarget): LocalIdentity {
    return {
      isbn13: target.isbn13 === undefined ? undefined : normalizeIsbn13(target.isbn13),
      reference:
        target.source === undefined || target.externalId === undefined
          ? undefined
          : { source: target.source, externalId: target.externalId },
    }
  }

  async findLocal(client: LocalClient, identity: LocalIdentity): Promise<LocalResolution> {
    const [byIsbn, byReference] = await Promise.all([
      identity.isbn13 === undefined
        ? null
        : client.edition.findUnique({ where: { isbn13: identity.isbn13 }, select: { id: true } }),
      identity.reference === undefined
        ? null
        : client.editionExternalReference.findUnique({
            where: { source_externalId: identity.reference },
            select: { editionId: true, edition: { select: { isbn13: true } } },
          }),
    ])

    if (byIsbn !== null && byReference !== null && byIsbn.id !== byReference.editionId) {
      throw identityConflict({
        isbnEditionId: byIsbn.id,
        referenceEditionId: byReference.editionId,
      })
    }

    // Посилання веде на видання з ІНШИМ ISBN, ніж названий: ідентичність суперечлива, а не «та сама».
    if (
      byIsbn === null &&
      byReference !== null &&
      identity.isbn13 !== undefined &&
      byReference.edition.isbn13 !== null &&
      byReference.edition.isbn13 !== identity.isbn13
    ) {
      throw identityConflict({ referenceEditionId: byReference.editionId })
    }

    return {
      editionId: byIsbn?.id ?? byReference?.editionId,
      referenceKnown: byReference !== null,
    }
  }

  /** Мережа. Не викликати всередині транзакції. */
  async fetch(target: QuickAddExternalEditionTarget): Promise<ConfirmedExternalEdition> {
    const named = ExternalEditionResolver.namedBy(target)

    if (named.reference !== undefined) return this.fetchVolume(named)

    if (named.isbn13 === undefined) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Потрібен ISBN-13 або пара source + externalId',
        HttpStatus.BAD_REQUEST,
      )
    }

    const result = await this.lookup.lookup(named.isbn13)

    return {
      // Точний пошук за ISBN: відповідь саме про це видання.
      isbn13: named.isbn13,
      ...(result.source === undefined || result.externalId === undefined
        ? {}
        : { reference: { source: result.source, externalId: result.externalId } }),
      metadata: toMetadata(result),
    }
  }

  private async fetchVolume(named: LocalIdentity): Promise<ConfirmedExternalEdition> {
    const reference = named.reference

    if (reference === undefined) throw new Error('fetchVolume без посилання')

    const outcome = await runWithTimeout(lookupTimeoutMs(), (signal) =>
      this.volumes.fetchVolume(reference.externalId, signal),
    )

    if (outcome.kind === 'timeout') {
      throw new ApiException(
        API_ERROR_CODES.CATALOG_LOOKUP_TIMEOUT,
        'Зовнішній провайдер не відповів вчасно',
        HttpStatus.GATEWAY_TIMEOUT,
      )
    }

    if (outcome.kind === 'error') {
      const description =
        outcome.error instanceof BookLookupProviderError
          ? outcome.error.message
          : String(outcome.error)

      throw new ApiException(
        API_ERROR_CODES.CATALOG_LOOKUP_PROVIDER_ERROR,
        `Зовнішній провайдер повернув помилку: ${description}`,
        HttpStatus.BAD_GATEWAY,
      )
    }

    const volume = outcome.value

    if (volume === undefined) {
      throw new ApiException(
        API_ERROR_CODES.CATALOG_LOOKUP_NOT_FOUND,
        'Зовнішній провайдер не знає цього видання',
        HttpStatus.NOT_FOUND,
      )
    }

    // ISBN, названий клієнтом, не може суперечити тому: інакше це не те видання, яке людина вибрала.
    if (
      named.isbn13 !== undefined &&
      volume.isbn13 !== undefined &&
      volume.isbn13 !== named.isbn13
    ) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'ISBN не збігається з виданням, яке повідомило джерело',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    return {
      // ISBN береться ЛИШЕ з відповіді джерела: названий клієнтом, але не підтверджений, не використовується.
      ...(volume.isbn13 === undefined ? {} : { isbn13: volume.isbn13 }),
      reference: { source: reference.source, externalId: volume.externalId },
      metadata: toMetadata(volume.result),
    }
  }
}

function toMetadata(result: BookLookupResult): ExternalMetadata {
  return {
    title: result.title,
    authors: result.authors ?? [],
    ...(result.publishedYear === undefined ? {} : { publishedYear: result.publishedYear }),
    ...(result.language === undefined || !isLanguageCode(result.language)
      ? {}
      : { language: result.language }),
    ...(result.publisher === undefined ? {} : { publisher: result.publisher }),
    ...(result.description === undefined ? {} : { description: result.description }),
    ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
    ...(result.format === undefined ? {} : { format: result.format }),
    ...(result.coverUrl === undefined ? {} : { coverUrl: result.coverUrl }),
  }
}
