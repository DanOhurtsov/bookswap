import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type CopyHistoryResponse,
  type MyHistoryResponse,
  type WorkHistoryResponse,
} from '@bookswap/shared'
import { AccessService, blocked } from '../access/access.service'
import { copyVisibleTo, holderNamesVisibleTo, type ViewerRole } from '../access/visibility'
import { toEdition, toWork, toWorkAuthors } from '../catalog/catalog.mapper'
import { ApiException } from '../common/api.exception'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS } from '../users/user.mapper'
import {
  byRequestedAt,
  hasRegisteredBorrower,
  toHistoryCopy,
  toHistoryEntry,
  toNamedEntry,
} from './history.mapper'
import type { FriendRelation, LoanStatus } from '@bookswap/shared'

/**
 * Stage 10 (T5): позика, яку власник записав і яка ще не підтверджена (або відхилена), — це
 * претензія однієї сторони, а не факт. Її бачать лише сторони позики.
 */
const CLAIM_STATUSES: readonly LoanStatus[] = ['PENDING_CONFIRMATION', 'DECLINED']

/**
 * Stage 10 (10b, Q8): «Хто читав» — лише фактична передача. `LOST` рахується, тільки якщо передача
 * відбулася (`handedAt != null`); решта статусів — це запит, відмова або претензія, а не читання.
 */
const READ_STATUSES: LoanStatus[] = ['HANDED_OVER', 'RETURNED', 'LOST']

/** Каталожний контекст примірника — рівно те, що читає `history.mapper`. */
const COPY_CATALOG = {
  edition: {
    include: {
      translation: true,
      work: { include: { authors: { include: { author: true } } } },
    },
  },
} as const

const WITH_SIDES = {
  owner: { select: PUBLIC_USER_FIELDS },
  borrower: { select: PUBLIC_USER_FIELDS },
} as const

/**
 * §6.6. Історія виводиться з `Loan`; окремих таблиць немає (§4.6).
 *
 * Модуль читає `Loan`, але **не змінює** його — і не має способу: `LoanService`
 * тут не інжектується взагалі. §5 вимагає, щоб переходи йшли крізь одну точку;
 * найпростіший спосіб цього не порушити — щоб читач історії не мав доступу до
 * запису.
 *
 * Рішення «чи видно» ухвалюють чисті функції §9, роль постачає `AccessService` —
 * власного `findFirst` по `Friendship` тут немає.
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /**
   * §8: `GET /copies/:id/history` — усі лоани конкретного примірника в хронології.
   *
   * §9, рядок «Історія примірника з іменами»: власник — завжди; друг — за
   * `showHolderNames`; інший — «✗». Саме «✗», а не «без імен»: сторонньому історія
   * не належить у принципі, навіть коли прапорець увімкнено.
   */
  async copyHistory(viewerId: string, copyId: string): Promise<CopyHistoryResponse> {
    const copy = await this.prisma.copy.findUnique({
      where: { id: copyId },
      select: {
        id: true,
        ownerId: true,
        status: true,
        condition: true,
        visibility: true,
        owner: { select: { libraryVisibility: true, showHolderNames: true } },
        ...COPY_CATALOG,
      },
    })

    if (copy === null) throw notFound('Примірника не знайдено')

    const role = await this.access.roleOf(viewerId, copy.ownerId)

    if (role === 'BLOCKED') throw blocked()

    // Невидимий примірник не існує для того, хто питає, — тому 404, а не 403:
    // 403 підтвердив би, що примірник із таким id у цієї людини є.
    if (!copyVisibleTo(role, copy.owner.libraryVisibility, copy.visibility)) {
      throw notFound('Примірника не знайдено')
    }

    // §9: сторонній не бачить історії навіть публічного примірника. Видимість
    // полиці й доступ до того, хто що в кого брав, — різні питання.
    assertHistoryVisible(role)

    const loans = (
      await this.prisma.loan.findMany({
        where: { copyId: copy.id },
        include: WITH_SIDES,
      })
    ).filter((loan) => isVisibleToParty(loan, viewerId))

    const showNames = holderNamesVisibleTo(role, copy.owner.showHolderNames)
    const now = new Date()

    return {
      copy: toHistoryCopy(copy),
      entries: [...loans].sort(byRequestedAt).map((loan) => toHistoryEntry(loan, showNames, now)),
    }
  }

  /**
   * §8: `GET /works/:id/history` — «хто з моїх це взагалі читав».
   *
   * §6.6 називає це практично кориснішим за історію примірника, і це видно з
   * питання, на яке воно відповідає: «чи варто просити цю книжку» вирішують до
   * того, як обрали конкретний том.
   *
   * Обсяг — примірники цього твору в друзів і у себе. Ролі беруться одним запитом
   * через `relationsWith`: власників у твору буває кілька, і запит на кожного
   * перетворив би сторінку на десяток звернень до бази.
   */
  async workHistory(viewerId: string, workId: string): Promise<WorkHistoryResponse> {
    const work = await this.prisma.work.findUnique({
      where: { id: workId },
      include: { authors: { include: { author: true } } },
    })

    if (work === null) throw notFound('Твір не знайдено')

    const copies = await this.prisma.copy.findMany({
      where: { edition: { workId } },
      select: {
        id: true,
        ownerId: true,
        visibility: true,
        owner: { select: { libraryVisibility: true, showHolderNames: true } },
        edition: { include: { translation: true, work: true } },
        loans: {
          where: { status: { in: READ_STATUSES }, handedAt: { not: null } },
          include: WITH_SIDES,
        },
      },
    })

    const ownerIds = [...new Set(copies.map((copy) => copy.ownerId))]
    const relations = await this.access.relationsWith(viewerId, ownerIds)
    const now = new Date()
    const entries: WorkHistoryResponse['entries'] = []

    for (const copy of copies) {
      // Роль рахується на **кожного власника окремо**: серед примірників одного
      // твору бувають і свій, і друга, і чужий, і від цього залежать різні
      // відповіді на «чи видно» та «чи з іменами».
      const role = roleFor(viewerId, copy.ownerId, relations.get(copy.ownerId))

      if (!copyVisibleTo(role, copy.owner.libraryVisibility, copy.visibility)) continue
      if (!isHistoryVisible(role)) continue

      const showNames = holderNamesVisibleTo(role, copy.owner.showHolderNames)

      for (const loan of [...copy.loans].sort(byRequestedAt)) {
        entries.push({
          entry: toHistoryEntry(loan, showNames, now),
          copyId: copy.id,
          edition: toEdition(copy.edition, copy.edition.work),
        })
      }
    }

    return {
      work: toWork(work),
      authors: toWorkAuthors(work.authors),
      entries,
    }
  }

  /**
   * §8: `GET /me/history` — «що я брав і що в мене брали».
   *
   * Обидва списки завжди з іменами: viewer — сторона кожного з цих лоанів, а не
   * стороння людина, тож §6.6 сюди не застосовується.
   */
  async myHistory(userId: string): Promise<MyHistoryResponse> {
    const loans = await this.prisma.loan.findMany({
      where: { OR: [{ borrowerId: userId }, { ownerId: userId }] },
      include: {
        ...WITH_SIDES,
        copy: { select: { id: true, status: true, condition: true, ...COPY_CATALOG } },
      },
    })

    const now = new Date()
    // Гостьові позики (`borrower = null`) з'являться в «Моїй історії» власника разом з
    // аліасом у кроці 10f; до того їх не існує, а іменована проєкція без імені неможлива.
    const ordered = loans
      .filter(hasRegisteredBorrower)
      .sort((one, other) => byRequestedAt(other, one))
    const project = (loan: (typeof ordered)[number]): MyHistoryResponse['borrowed'][number] => ({
      entry: toNamedEntry(loan, now),
      copy: toHistoryCopy(loan.copy),
    })

    return {
      borrowed: ordered.filter((loan) => loan.borrowerId === userId).map(project),
      lent: ordered.filter((loan) => loan.ownerId === userId).map(project),
    }
  }
}

/** Претензії (`PENDING_CONFIRMATION`/`DECLINED`) бачать лише власник і позичальник цієї позики. */
function isVisibleToParty(
  loan: { status: LoanStatus; ownerId: string; borrowerId: string | null },
  viewerId: string,
): boolean {
  if (!CLAIM_STATUSES.includes(loan.status)) return true

  return loan.ownerId === viewerId || loan.borrowerId === viewerId
}

/**
 * §9: історію бачать лише власник і друг.
 *
 * Винесено окремо, бо це правило застосовується двічі й обидва рази мусить
 * означати те саме. `BLOCKED` сюди не доходить — його відсікають раніше.
 */
function isHistoryVisible(role: ViewerRole): boolean {
  return role === 'OWNER' || role === 'FRIEND'
}

function assertHistoryVisible(role: ViewerRole): void {
  if (isHistoryVisible(role)) return

  throw new ApiException(
    API_ERROR_CODES.FORBIDDEN,
    'Історія цього примірника доступна лише власнику та його друзям',
    HttpStatus.FORBIDDEN,
  )
}

/**
 * Те саме, що робить `AccessService.roleOf`, але на вже прочитаному стані пари.
 *
 * Існує лише заради `workHistory`: власників у твору буває кілька, і запит ролі
 * на кожного перетворив би сторінку на десяток звернень до бази. `relationsWith`
 * віддає їх усі одним запитом, а ця функція перекладає результат у ту саму
 * `ViewerRole`, якою користуються чисті функції §9.
 */
function roleFor(
  viewerId: string,
  ownerId: string,
  relation: FriendRelation | undefined,
): ViewerRole {
  if (viewerId === ownerId) return 'OWNER'
  if (relation === 'BLOCKED_BY_ME' || relation === 'BLOCKED_ME') return 'BLOCKED'

  return relation === 'FRIENDS' ? 'FRIEND' : 'OTHER'
}

function notFound(message: string): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND)
}
