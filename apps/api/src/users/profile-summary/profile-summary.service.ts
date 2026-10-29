import { Injectable } from '@nestjs/common'
import { OPEN_LOAN_STATUS, PROFILE_SUMMARY_LIMITS, type ProfileSummary } from '@bookswap/shared'
import { WITH_CATALOG } from '../../library/library-includes'
import { PrismaService } from '../../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../user.mapper'
import {
  HANDED_LOAN_STATUSES,
  averageLoanDays,
  latestActivity,
  toProfileBook,
  type ActivityLoanRow,
  type AddedCopiesDay,
} from './profile-summary.mapper'
import type { Prisma } from '../../generated/prisma/client'
import type { LoanStatus } from '../../generated/prisma/enums'

const OPEN_LOAN_STATUSES: LoanStatus[] = [...OPEN_LOAN_STATUS]

const CONTACT_ALIAS = { select: { alias: true } } as const

const SUMMARY_COPY = {
  id: true,
  ownerId: true,
  currentHolderId: true,
  heldByContactId: true,
  status: true,
  edition: WITH_CATALOG.edition,
  currentHolder: { select: PUBLIC_USER_FIELDS },
  heldByContact: CONTACT_ALIAS,
  loans: {
    where: { status: { in: OPEN_LOAN_STATUSES } },
    select: {
      status: true,
      dueAt: true,
      borrower: { select: PUBLIC_USER_FIELDS },
      borrowerContact: CONTACT_ALIAS,
    },
  },
} as const satisfies Prisma.CopySelect

const ACTIVITY_LOAN = {
  id: true,
  ownerId: true,
  origin: true,
  status: true,
  requestedAt: true,
  respondedAt: true,
  handedAt: true,
  returnedAt: true,
  owner: { select: PUBLIC_USER_FIELDS },
  borrower: { select: PUBLIC_USER_FIELDS },
  borrowerContact: CONTACT_ALIAS,
  copy: { select: { edition: { select: { work: { select: { id: true, title: true } } } } } },
} as const satisfies Prisma.LoanSelect

const STEP_COLUMNS = ['requestedAt', 'respondedAt', 'handedAt', 'returnedAt'] as const

type StepColumn = (typeof STEP_COLUMNS)[number]

/** Which loans may carry each step — the same rules `loanStepsOf` applies (see there). */
const STEP_FILTERS: Record<StepColumn, Prisma.LoanWhereInput> = {
  requestedAt: { origin: 'REQUESTED' },
  respondedAt: { origin: 'REQUESTED' },
  handedAt: { status: { in: HANDED_LOAN_STATUSES } },
  returnedAt: { status: 'RETURNED' },
}

interface ReliabilityRow {
  returnedWithDue: number
  returnedOnTime: number
  averageSeconds: number | null
}

/**
 * BS-148, sub-stage E: `GET /me/profile-summary`. A fixed number of queries whatever the size of the
 * library (CONVENTIONS §8.6), run side by side; everything is about the caller, so there is nothing
 * to authorize beyond the session.
 */
@Injectable()
export class ProfileSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summaryOf(userId: string, now: Date = new Date()): Promise<ProfileSummary> {
    const ownCopies: Prisma.CopyWhereInput = { ownerId: userId, archivedAt: null }
    const friendships: Prisma.FriendshipWhereInput = {
      status: 'ACCEPTED',
      OR: [{ userAId: userId }, { userBId: userId }],
    }

    const [
      copies,
      friends,
      lentLoans,
      wishlist,
      reliability,
      outNow,
      books,
      friendRows,
      activityLoans,
      addedDays,
    ] = await Promise.all([
      this.prisma.copy.count({ where: ownCopies }),
      this.prisma.friendship.count({ where: friendships }),
      this.prisma.loan.count({ where: { ownerId: userId, status: { in: HANDED_LOAN_STATUSES } } }),
      this.prisma.wishlistItem.count({ where: { userId } }),
      this.reliabilityOf(userId),
      // The same set as `LibraryService.listOut`: a guest holder leaves `currentHolderId` NULL.
      this.prisma.copy.count({
        where: {
          ...ownCopies,
          OR: [{ currentHolderId: null }, { currentHolderId: { not: userId } }],
        },
      }),
      this.prisma.copy.findMany({
        where: ownCopies,
        select: SUMMARY_COPY,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PROFILE_SUMMARY_LIMITS.books,
      }),
      this.prisma.friendship.findMany({
        where: friendships,
        select: {
          userAId: true,
          userA: { select: PUBLIC_USER_FIELDS },
          userB: { select: PUBLIC_USER_FIELDS },
        },
        // As `FriendsService.listFriends`: the newest friendships first.
        orderBy: [{ respondedAt: 'desc' }, { id: 'desc' }],
        take: PROFILE_SUMMARY_LIMITS.friends,
      }),
      this.activityLoansOf(userId),
      this.addedCopiesDaysOf(userId),
    ])

    return {
      stats: { copies, friends, lentLoans, wishlist },
      reliability: {
        returnedOnTime: reliability.returnedOnTime,
        returnedWithDue: reliability.returnedWithDue,
        averageLoanDays: averageLoanDays(reliability.averageSeconds),
        outNow,
      },
      books: { items: books.map((copy) => toProfileBook(copy, now)), total: copies },
      friends: {
        items: friendRows.map((row) =>
          toPublicUser(row.userAId === userId ? row.userB : row.userA),
        ),
        total: friends,
      },
      activity: latestActivity(activityLoans, addedDays, userId, PROFILE_SUMMARY_LIMITS.activity),
    }
  }

  /**
   * My returns as a borrower (PO decision, 26.10.2026). `dueAt` is the end of the due day (UTC,
   * `toDueDate`), so «on time» is `returnedAt ≤ dueAt`; a loan without a due day is neither on time
   * nor late, but its length still counts towards the average.
   */
  private async reliabilityOf(userId: string): Promise<ReliabilityRow> {
    const [row] = await this.prisma.$queryRaw<ReliabilityRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "dueAt" IS NOT NULL)::int AS "returnedWithDue",
        COUNT(*) FILTER (WHERE "dueAt" IS NOT NULL AND "returnedAt" <= "dueAt")::int AS "returnedOnTime",
        AVG(EXTRACT(EPOCH FROM ("returnedAt" - "handedAt")))::float8 AS "averageSeconds"
      FROM "Loan"
      WHERE "borrowerId" = ${userId} AND "status" = 'RETURNED' AND "returnedAt" IS NOT NULL
    `

    return row ?? { returnedWithDue: 0, returnedOnTime: 0, averageSeconds: null }
  }

  /**
   * The latest steps of my loans in either role. Every one of the newest `limit` steps is among the
   * newest `limit` values of its own timestamp, so one short query per timestamp is enough —
   * `latestActivity` merges them and takes each loan once.
   */
  private async activityLoansOf(userId: string): Promise<ActivityLoanRow[]> {
    const mine: Prisma.LoanWhereInput = { OR: [{ ownerId: userId }, { borrowerId: userId }] }
    const batches = await Promise.all(
      STEP_COLUMNS.map((column) =>
        this.prisma.loan.findMany({
          where: { AND: [mine, STEP_FILTERS[column], { [column]: { not: null } }] },
          select: ACTIVITY_LOAN,
          orderBy: [{ [column]: 'desc' }, { id: 'desc' }],
          take: PROFILE_SUMMARY_LIMITS.activity,
        }),
      ),
    )

    return batches.flat()
  }

  /**
   * «Ви додали 3 книжки до бібліотеки»: one line per UTC calendar day — the day `Copy.createdAt` is
   * stored in. Archived copies count: they were added all the same.
   */
  private async addedCopiesDaysOf(userId: string): Promise<AddedCopiesDay[]> {
    return this.prisma.$queryRaw<AddedCopiesDay[]>`
      SELECT COUNT(*)::int AS "count", MAX("createdAt") AS "at"
      FROM "Copy"
      WHERE "ownerId" = ${userId}
      GROUP BY "createdAt"::date
      ORDER BY "at" DESC
      LIMIT ${PROFILE_SUMMARY_LIMITS.activity}
    `
  }
}
