import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  EXCLUSIVE_LOAN_STATUS,
  OPEN_LOAN_STATUS,
  type AddCopyRequest,
  type BorrowedLibraryResponse,
  type CopyResponse,
  type LibraryQueryRequest,
  type LibraryResponse,
  type UpdateCopyRequest,
  type VisibleLibraryResponse,
} from '@bookswap/shared'
import { AccessService, blocked } from '../access/access.service'
import { copyVisibleTo, holderNamesVisibleTo, isVisibleTo } from '../access/visibility'
import { AnalyticsService } from '../analytics/analytics.service'
import { NetworkActivationService } from '../analytics/network-activation.service'
import { TextNormalizer } from '../catalog/text-normalizer'
import { ApiException } from '../common/api.exception'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../users/user.mapper'
import {
  groupByEdition,
  toBorrowedCopy,
  toOwnCopy,
  toVisibleCopy,
  type CopyRow,
} from './library.mapper'
import type { LoanStatus } from '../generated/prisma/enums'
import type { CopyWhereInput } from '../generated/prisma/models'

/**
 * §5.2: видалення примірника заблоковане, поки лоан у цих статусах.
 *
 * Це не формальність: `Copy → Loan` каскадний, тож видалення примірника з
 * активним лоаном не просто загубило б домовленість — воно стерло б **історію**
 * позичань, яка в цій моделі живе виключно в `Loan` (§4.6).
 *
 * Список зі `shared`, а не локальний: це рівно та множина, яку тримає частковий
 * унікальний індекс `one_active_loan_per_copy` (§5.3.1), і другу її копію одного
 * дня забули б оновити.
 */
const ACTIVE_LOAN_STATUSES: LoanStatus[] = [...EXCLUSIVE_LOAN_STATUS]

/** Незавершені лоани — ті, що впливають на §6.5. Копія масиву: Prisma хоче змінюваний. */
const OPEN_LOAN_STATUSES: LoanStatus[] = [...OPEN_LOAN_STATUS]

/**
 * Каталожний контекст примірника — саме той набір полів, який читає
 * `library.mapper`. Один опис на всі запити: інакше «чому на одній сторінці є
 * автори, а на іншій немає» стало б регулярним питанням.
 */
const WITH_CATALOG = {
  edition: {
    include: {
      translation: true,
      work: { include: { authors: { include: { author: true } } } },
    },
  },
  owner: { select: PUBLIC_USER_FIELDS },
  currentHolder: { select: PUBLIC_USER_FIELDS },
  /**
   * §6.5: стан кнопки «Попросити» не виводиться з `Copy.status` — за §5.1 запит
   * примірника не змінює, тож `AVAILABLE` не означає «ви ще не просили».
   *
   * Термінальні лоани не читаються: вони — історія, і для неї є `/copies/:id/history`.
   * Проєкція вужча за `WITH_CONTEXT` у `loans/`: тут потрібні лише id, статус і
   * позичальник, а самі мапери віддають із цього ще менше — і різне за роллю.
   */
  loans: {
    where: { status: { in: OPEN_LOAN_STATUSES } },
    select: {
      id: true,
      status: true,
      borrowerId: true,
      // §6.5: «орієнтовна дата повернення, якщо власник її вказав». Назовні з
      // цього рядка йде тільки вона — див. `expectedReturnOf`.
      dueAt: true,
      borrower: { select: PUBLIC_USER_FIELDS },
    },
  },
} as const

/**
 * Особиста бібліотека (§6.4) і бібліотека іншої людини (§6.5).
 *
 * Єдине місце, де читаються `Copy`. Рішення «чи можна це бачити» ухвалюють чисті
 * функції §9 з `access/visibility.ts`, а роль постачає `AccessService.roleOf()` —
 * тут не має бути жодного власного `findFirst` по `Friendship`.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly network: NetworkActivationService,
    private readonly access: AccessService,
    private readonly normalizer: TextNormalizer,
  ) {}

  /** §8: `GET /me/library?status=&lang=&q=`. */
  async listOwn(userId: string, filters: LibraryQueryRequest): Promise<LibraryResponse> {
    const copies = await this.findCopies({
      ownerId: userId,
      AND: await this.filterConditions(filters),
    })

    return { groups: groupByEdition(copies, toOwnCopy) }
  }

  /** §6.4, в'ю «Мої книжки не вдома»: `currentHolderId ≠ ownerId`. */
  async listOut(userId: string): Promise<LibraryResponse> {
    const copies = await this.findCopies({
      ownerId: userId,
      currentHolderId: { not: userId },
    })

    return { groups: groupByEdition(copies, toOwnCopy) }
  }

  /** §6.4, в'ю «Чужі книжки в мене»: `currentHolderId = me AND ownerId ≠ me`. */
  async listBorrowed(userId: string): Promise<BorrowedLibraryResponse> {
    const copies = await this.findCopies({
      currentHolderId: userId,
      ownerId: { not: userId },
    })

    return { groups: groupByEdition(copies, (copy) => toBorrowedCopy(copy, userId)) }
  }

  /**
   * §6.5 і матриця §9.
   *
   * Три різні перевірки, і жодну не можна пропустити: блокування сильніше за
   * будь-яку видимість (§6.2), видимість бібліотеки вирішує доступ до сторінки
   * взагалі, а видимість кожного примірника — найсуворіше з двох (§9).
   *
   * Примірники фільтруються в застосунку, а не запитом: правило §9 живе однією
   * чистою функцією, і переписати його SQL-умовою означало б завести другу
   * реалізацію тієї самої матриці. Обсяг тут — домашня полиця, не стрічка.
   */
  async listOf(viewerId: string, ownerId: string): Promise<VisibleLibraryResponse> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { ...PUBLIC_USER_FIELDS, libraryVisibility: true, showHolderNames: true },
    })

    if (owner === null) throw notFound('Користувача не знайдено')

    const role = await this.access.roleOf(viewerId, ownerId)

    if (role === 'BLOCKED') throw blocked()

    if (!isVisibleTo(role, owner.libraryVisibility)) {
      throw new ApiException(
        API_ERROR_CODES.FORBIDDEN,
        'Ця бібліотека недоступна',
        HttpStatus.FORBIDDEN,
      )
    }

    const showHolderNames = holderNamesVisibleTo(role, owner.showHolderNames)
    const copies = await this.findCopies({ ownerId })
    const visible = copies.filter((copy) =>
      copyVisibleTo(role, owner.libraryVisibility, copy.visibility),
    )
    const groups = groupByEdition(visible, (copy) =>
      toVisibleCopy(copy, { id: viewerId, role, showHolderNames }),
    )
    const wishlisted = await this.wishlistedWorkIds(
      viewerId,
      groups.map((group) => group.work.id),
    )

    return {
      owner: toPublicUser(owner),
      groups: groups.map((group) => ({ ...group, inWishlist: wishlisted.has(group.work.id) })),
    }
  }

  /**
   * §6.5: «Позначка, які з них у вішлисті користувача». Читається напряму
   * `PrismaService`, а не через `WishlistModule`: питання тут вужче за весь
   * вішлист — лише «чи є рядок для цих `Work`» — і не варте окремої залежності
   * між модулями заради одного `findMany`.
   */
  private async wishlistedWorkIds(viewerId: string, workIds: string[]): Promise<Set<string>> {
    if (workIds.length === 0) return new Set()

    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId: viewerId, workId: { in: workIds } },
      select: { workId: true },
    })

    return new Set(rows.map((row) => row.workId))
  }

  /**
   * §8: `POST /me/library { editionId, condition, note, visibility, entryMethod? }`.
   *
   * `currentHolderId = ownerId` — книжка вдома, тобто інваріант §5.3.2 виконано
   * від народження примірника.
   */
  async addCopy(userId: string, request: AddCopyRequest): Promise<CopyResponse> {
    const edition = await this.prisma.edition.findUnique({
      where: { id: request.editionId },
      select: { id: true },
    })

    if (edition === null) throw notFound('Видання не знайдено')

    const copy = await this.prisma.copy.create({
      data: {
        editionId: request.editionId,
        ownerId: userId,
        currentHolderId: userId,
        condition: request.condition ?? 'GOOD',
        note: request.note ?? null,
        visibility: request.visibility ?? 'FRIENDS',
        acquiredAt: toDate(request.acquiredAt),
      },
      include: WITH_CATALOG,
    })

    await this.analytics.record({
      type: 'BOOK_ADDED',
      subjectUserId: userId,
      domainEntityId: copy.id,
      properties: { method: request.entryMethod ?? 'MANUAL' },
    })
    await this.network.onInventoryAdded(userId)

    return { copy: toOwnCopy(copy) }
  }

  /**
   * §6.4: редагування примірника.
   *
   * Перевірка «книжка вдома й без активного лоану» стосується **лише** поля
   * `status`. Нотатку, стан і видимість власник міняє завжди — саме тоді, коли
   * книжка в когось, вони й потрібні: «віддав Марті, обіцяла до Різдва».
   * `RESERVED` і `LENT_OUT` сюди не доходять узагалі — їх відсікає валідація
   * DTO, бо цими станами керує лише стейт-машина §5.
   */
  async updateCopy(
    userId: string,
    copyId: string,
    request: UpdateCopyRequest,
  ): Promise<CopyResponse> {
    const existing = await this.prisma.copy.findUnique({
      where: { id: copyId },
      select: { id: true, ownerId: true, currentHolderId: true },
    })

    // Чужий примірник — це не «заборонено», а «немає у вашій бібліотеці»:
    // маршрут адресує `/me/library`, і чужий id у ньому просто не існує.
    if (existing === null || existing.ownerId !== userId) throw notFound('Примірника не знайдено')

    const changesStatus = request.status !== undefined

    // Умови в самому `updateMany`, а не перевіркою перед ним: між читанням і
    // записом лоан може змінити стан, і саме база мусить вирішити гонку — той
    // самий оптимістичний прийом, що в `FriendsService`.
    const { count } = await this.prisma.copy.updateMany({
      where: {
        id: copyId,
        ownerId: userId,
        ...(changesStatus
          ? { currentHolderId: userId, loans: { none: { status: { in: ACTIVE_LOAN_STATUSES } } } }
          : {}),
      },
      data: {
        condition: request.condition,
        note: request.note,
        visibility: request.visibility,
        acquiredAt: request.acquiredAt === undefined ? undefined : toDate(request.acquiredAt),
        status: request.status,
      },
    })

    if (count === 0) {
      // Без зміни статусу умов у `where` немає, тож нуль рядків означає лише
      // одне: примірник зник між читанням і записом.
      if (!changesStatus) throw notFound('Примірника не знайдено')

      throw new ApiException(
        API_ERROR_CODES.COPY_STATUS_LOCKED,
        'Статус не можна змінити, поки книжка не вдома або має активне позичання',
        HttpStatus.CONFLICT,
      )
    }

    const copy = await this.prisma.copy.findUniqueOrThrow({
      where: { id: copyId },
      include: WITH_CATALOG,
    })

    return { copy: toOwnCopy(copy) }
  }

  /** §5.2: «Видалення примірника заблоковане, поки є лоан у APPROVED або HANDED_OVER». */
  async removeCopy(userId: string, copyId: string): Promise<void> {
    const existing = await this.prisma.copy.findUnique({
      where: { id: copyId },
      select: { id: true, ownerId: true },
    })

    if (existing === null || existing.ownerId !== userId) throw notFound('Примірника не знайдено')

    const { count } = await this.prisma.copy.deleteMany({
      where: {
        id: copyId,
        ownerId: userId,
        loans: { none: { status: { in: ACTIVE_LOAN_STATUSES } } },
      },
    })

    if (count === 0) {
      throw new ApiException(
        API_ERROR_CODES.COPY_HAS_ACTIVE_LOAN,
        'Примірник не можна видалити: він зараз у позичанні',
        HttpStatus.CONFLICT,
      )
    }
  }

  private async findCopies(where: CopyWhereInput): Promise<CopyRow[]> {
    return this.prisma.copy.findMany({ where, include: WITH_CATALOG })
  }

  /**
   * §8: `?status=&lang=&q=`.
   *
   * `lang` — мова **видання**: з перекладу, а для видання мовою оригіналу — з
   * твору. `q` шукає і за назвою, і за автором, по нормалізованих колонках і
   * тією ж нормалізацією, що й каталожний пошук: інакше «шевченко» знаходило б
   * у каталозі й не знаходило у власній бібліотеці.
   */
  private async filterConditions(filters: LibraryQueryRequest): Promise<CopyWhereInput[]> {
    const conditions: CopyWhereInput[] = []

    if (filters.status !== undefined) conditions.push({ status: filters.status })

    if (filters.lang !== undefined) {
      conditions.push({
        OR: [
          { edition: { translation: { lang: filters.lang } } },
          { edition: { translationId: null, work: { origLang: filters.lang } } },
        ],
      })
    }

    if (filters.q !== undefined) {
      const term = await this.normalizer.normalize(filters.q)

      conditions.push({
        edition: {
          work: {
            OR: [
              { titleNorm: { contains: term } },
              { authors: { some: { author: { nameNorm: { contains: term } } } } },
            ],
          },
        },
      })
    }

    return conditions
  }
}

/** Дата без часу — опівночі UTC, щоб день не «поїхав» на межі часових поясів. */
function toDate(value: string | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(`${value}T00:00:00.000Z`)
}

function notFound(message: string): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND)
}
