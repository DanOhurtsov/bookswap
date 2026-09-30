import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  READING_LIST_LIMITS,
  type ReadingListQueryRequest,
  type ReadingListResponse,
  type ReadingStatus,
  type ReadingStatusResponse,
  type SetReadingStatusResponse,
} from '@bookswap/shared'
import {
  CanonicalWorkService,
  workMergedConflict,
} from '../catalog/canonical/canonical-work.service'
import { ApiException } from '../common/api.exception'
import { ACTUAL_HANDOVER } from '../history/actual-handover'
import { PrismaService } from '../prisma/prisma.service'
import { decodeCursor, encodeCursor } from './reading-status.cursor'
import { toReadingListItem, type ReadingListRow } from './reading-status.mapper'

/** Проєкція, яку читає `reading-status.mapper` — той самий набір, що й у вішлисті. */
const WITH_WORK = {
  work: { include: { authors: { include: { author: true } } } },
} as const

/**
 * Stage 10 (10j.1, §6.15). Особистий статус читання зареєстрованого користувача щодо `Work` (R-2).
 *
 * Модуль читає `Loan` лише для тега `wasBorrowed` і ніколи його не змінює; жоден перехід `Loan` не
 * пише сюди (R-3). Користувач — завжди з сесії: жоден метод не приймає чужий `userId`.
 */
@Injectable()
export class ReadingStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly canonical: CanonicalWorkService,
  ) {}

  /**
   * Q17: немає рядка = «не встановлювали». Рядок пишеться лише коли статус справді змінюється: повторний
   * PUT того самого статусу й `NOT_READ` за відсутності рядка — no-op без жодного запису й без зміни `updatedAt`.
   *
   * Q19 вирішує `updatedAt`, тож він мусить іти в порядку фактичних змін. Тому час ставить `stamp` —
   * `clock_timestamp()` бази, а не час початку запиту, — і лише тоді, коли рядок уже належить цій транзакції
   * (`FOR UPDATE` або власна щойно вставлена копія). PUT, що чекав на чуже блокування рядка, отримує час
   * після очікування, а не раніший за зміни, закомічені за цей час.
   *
   * `Work` блокується `FOR SHARE` на час запису: `MergeService` бере `FOR UPDATE` на тих самих рядках, тож
   * запис не може потрапити на вихідний `Work` посеред злиття й лишитись там осиротілим рядком. Порядок
   * блокувань — `Work`, потім `WorkReadingStatus` — той самий, що в `MergeService`.
   */
  async set(
    userId: string,
    requestedWorkId: string,
    status: ReadingStatus,
  ): Promise<SetReadingStatusResponse> {
    await this.prisma.$transaction(async (tx) => {
      const works = await tx.$queryRaw<{ mergedIntoId: string | null }[]>`
        SELECT "mergedIntoId" FROM "Work" WHERE "id" = ${requestedWorkId} FOR SHARE
      `
      const work = works[0]

      if (work === undefined) {
        throw new ApiException(API_ERROR_CODES.NOT_FOUND, 'Твір не знайдено', HttpStatus.NOT_FOUND)
      }

      if (work.mergedIntoId !== null) {
        throw workMergedConflict({
          workId: work.mergedIntoId,
          requestedWorkId,
          moved: true,
        })
      }

      await this.writeStatus(tx, userId, requestedWorkId, status)
    })

    return { workId: requestedWorkId, status }
  }

  /**
   * Коло повторюється лише в одному випадку: вставку випередила конкурентна вставка тієї самої пари, яка вже
   * закомічена (`skipDuplicates` нічого не вставив). Новий оператор у READ COMMITTED її бачить, тож наступне
   * коло блокує вже наявний рядок. Третє коло означало б порушений інваріант, а не гонку.
   */
  private async writeStatus(
    tx: WriteClient,
    userId: string,
    workId: string,
    status: ReadingStatus,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const locked = await tx.$queryRaw<{ id: string; status: ReadingStatus }[]>`
        SELECT "id", "status"::text AS "status" FROM "WorkReadingStatus"
        WHERE "userId" = ${userId} AND "workId" = ${workId}
        FOR UPDATE
      `
      const row = locked[0]

      if (row !== undefined) {
        if (row.status !== status) await stamp(tx, row.id, status)

        return
      }

      if (status === 'NOT_READ') return

      const created = await tx.workReadingStatus.createManyAndReturn({
        data: [{ userId, workId, status }],
        skipDuplicates: true,
        select: { id: true },
      })
      const own = created[0]

      if (own !== undefined) {
        // Вставка могла чекати на конкурентну вставку тієї самої пари, що зрештою відкотилась: час,
        // обчислений до вставки, був би раннім. Рядок уже наш — час ставиться тепер.
        await stamp(tx, own.id, status)

        return
      }
    }

    throw new Error(
      `WorkReadingStatus (${userId}, ${workId}): рядок не вдалося ні знайти, ні вставити`,
    )
  }

  /** Немає рядка або явний `NOT_READ` для клієнта однакові. Злитий `Work` читається як канонічний. */
  async get(userId: string, requestedWorkId: string): Promise<ReadingStatusResponse> {
    const { workId } = await this.canonical.resolve(requestedWorkId)
    const [row, borrowed] = await Promise.all([
      this.prisma.workReadingStatus.findUnique({
        where: { userId_workId: { userId, workId } },
        select: { status: true },
      }),
      this.borrowedWorkIds(userId, [workId]),
    ])

    return { workId, status: row?.status ?? 'NOT_READ', wasBorrowed: borrowed.has(workId) }
  }

  /**
   * Лише `READING`/`READ`, `updatedAt DESC, id DESC`, курсор — позиція в цьому порядку. Тег усіх рядків
   * сторінки обчислюється одним запитом до `Loan`, а не по запиту на рядок.
   */
  async list(userId: string, query: ReadingListQueryRequest): Promise<ReadingListResponse> {
    const limit = query.limit === undefined ? READING_LIST_LIMITS.pageDefault : Number(query.limit)
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)

    const rows = await this.prisma.workReadingStatus.findMany({
      where: {
        userId,
        status: query.status ?? { in: ['READING', 'READ'] },
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
              ],
            }),
      },
      include: WITH_WORK,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const borrowed = await this.borrowedWorkIds(
      userId,
      page.map((row) => row.workId),
    )

    return {
      items: page.map((row) =>
        toReadingListItem(
          row as ReadingListRow & { status: 'READING' | 'READ' },
          borrowed.has(row.workId),
        ),
      ),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    }
  }

  /**
   * T12: тег обчислюється під час читання з підтвердженої фактичної передачі **цьому зареєстрованому**
   * користувачу (R-5). Гостьова позика має `borrowerId IS NULL`, тож тега не дає. Предикат — та сама
   * `ACTUAL_HANDOVER`, що й у «Хто брав цю книжку» (10b).
   */
  private async borrowedWorkIds(userId: string, workIds: string[]): Promise<Set<string>> {
    if (workIds.length === 0) return new Set()

    const loans = await this.prisma.loan.findMany({
      where: {
        borrowerId: userId,
        borrowerKind: 'REGISTERED',
        ...ACTUAL_HANDOVER,
        copy: { edition: { workId: { in: workIds } } },
      },
      select: { copy: { select: { edition: { select: { workId: true } } } } },
    })

    return new Set(loans.map((loan) => loan.copy.edition.workId))
  }
}

type WriteClient = Pick<PrismaService, 'workReadingStatus' | '$queryRaw' | '$executeRaw'>

/**
 * Єдине місце, де пишеться `updatedAt`. Викликається лише для рядка, який ця транзакція вже тримає, тож
 * оператор не чекає і `clock_timestamp()` — момент після всіх очікувань. `AT TIME ZONE 'UTC'`: колонка
 * `timestamp` без зони, а Prisma зберігає в ній UTC незалежно від `TimeZone` сесії.
 */
async function stamp(tx: WriteClient, id: string, status: ReadingStatus): Promise<void> {
  await tx.$executeRaw`
    UPDATE "WorkReadingStatus"
    SET "status" = ${status}::"ReadingStatus", "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
    WHERE "id" = ${id}
  `
}
