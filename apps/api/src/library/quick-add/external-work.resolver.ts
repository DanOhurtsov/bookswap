import { Inject, Injectable } from '@nestjs/common'
import type { QuickAddExternalWorkTarget } from '@bookswap/shared'
import {
  EXTERNAL_WORK_PROVIDER,
  type ExternalWorkProvider,
} from '../../catalog/search/external/open-library-work-provider'
import type { PrismaService } from '../../prisma/prisma.service'
import { fromProvider, type ExternalReferenceKey } from './external-edition.resolver'

/** What the source itself says about the work — and nothing about any edition of it. */
export interface ConfirmedExternalWork {
  title: string
  authors: string[]
  /** The WORK's first publication year; never an edition's year. */
  firstPubYear?: number
  /** The cover the search card showed for this record. */
  coverUrl?: string
}

/** A confirmed work reference already in our catalog. */
export interface KnownExternalWork {
  workId: string
  /** The edition a direct add of this record created; `null` — the work was linked only through refining. */
  editionId: string | null
}

type LocalClient = Pick<PrismaService, 'workExternalReference'>

/**
 * Identity of an external WORK record (BS-114, docs/plan/fast-book-add.md, §13) — the counterpart of
 * `ExternalEditionResolver` for a record that describes a work, not a printing.
 *
 * `findLocal` reads only the database: a known record is added without the provider. `fetch` asks the
 * source, BEFORE the transaction; a `WorkExternalReference` is written only from its answer, never from the
 * client's words.
 */
@Injectable()
export class ExternalWorkResolver {
  constructor(@Inject(EXTERNAL_WORK_PROVIDER) private readonly works: ExternalWorkProvider) {}

  static keyOf(target: QuickAddExternalWorkTarget): ExternalReferenceKey {
    return { source: target.source, externalId: target.externalId }
  }

  async findLocal(
    client: LocalClient,
    key: ExternalReferenceKey,
  ): Promise<KnownExternalWork | null> {
    return client.workExternalReference.findUnique({
      where: { source_externalId: key },
      select: { workId: true, editionId: true },
    })
  }

  /** Network. Never inside a transaction. */
  async fetch(key: ExternalReferenceKey): Promise<ConfirmedExternalWork> {
    const record = await fromProvider('Зовнішнє джерело не знає цього твору', (signal) =>
      this.works.fetchWork(key.externalId, signal),
    )

    return {
      title: record.title,
      authors: record.authors ?? [],
      ...(record.firstPublishedYear === undefined
        ? {}
        : { firstPubYear: record.firstPublishedYear }),
      ...(record.coverUrl === undefined ? {} : { coverUrl: record.coverUrl }),
    }
  }
}
