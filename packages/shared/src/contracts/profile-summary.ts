import { z } from 'zod'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { publicUserSchema } from './user'

/**
 * BS-148, sub-stage E: `GET /api/v1/me/profile-summary` — everything the profile page shows beyond `Me`.
 *
 * Owner-only, like the guest-loan contract: the caller sees their own shelf and their own loans, so a
 * guest holder is named by the alias the owner gave them. Nothing here is ever shown to anyone else.
 */

export const PROFILE_SUMMARY_LIMITS = {
  books: 6,
  friends: 6,
  activity: 5,
} as const

const countSchema = z.number().int().nonnegative()

/** The other side of a loan: a registered person, or a guest by the owner's alias (`null` once erased, D3). */
export const profileCounterpartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('USER'), user: publicUserSchema }),
  z.object({ kind: z.literal('GUEST'), alias: z.string().nullable() }),
])

export type ProfileCounterpart = z.infer<typeof profileCounterpartSchema>

/**
 * Where my copy is now. Derived from `Copy.status`, the holder and the copy's open loans:
 *
 * - `HOME` / `HOME_REQUESTED` — available and home, with or without requests waiting;
 * - `RESERVED` — a request (or a record) is approved, the book has not left yet;
 * - `UNAVAILABLE` — home, and I am not lending it;
 * - `LENT` — with someone; `dueAt` is a calendar day, `overdue` is decided by the server (§5.2);
 * - `LOST` — marked lost: `UNAVAILABLE`, but still with the borrower (§5.1).
 */
export const profileBookPlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('HOME') }),
  z.object({
    kind: z.literal('HOME_REQUESTED'),
    pendingRequestCount: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('RESERVED'), borrower: profileCounterpartSchema }),
  z.object({ kind: z.literal('UNAVAILABLE') }),
  z.object({
    kind: z.literal('LENT'),
    holder: profileCounterpartSchema,
    dueAt: z.iso.date().nullable(),
    overdue: z.boolean(),
  }),
  z.object({ kind: z.literal('LOST'), holder: profileCounterpartSchema }),
])

export type ProfileBookPlace = z.infer<typeof profileBookPlaceSchema>

export const profileBookSchema = z.object({
  copyId: z.string(),
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  place: profileBookPlaceSchema,
})

export type ProfileBook = z.infer<typeof profileBookSchema>

export const PROFILE_LOAN_EVENT = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'HANDED_OVER',
  'RETURNED',
] as const

export const profileLoanEventSchema = z.enum(PROFILE_LOAN_EVENT)

export type ProfileLoanEvent = z.infer<typeof profileLoanEventSchema>

/**
 * One line of «Активність». A loan step is read from the loan's own timestamps (`requestedAt`,
 * `respondedAt`, `handedAt`, `returnedAt`) in either role; copies added on one calendar day (UTC) are
 * one line. `at` orders the list: for added copies it is the latest addition that day.
 */
export const profileActivitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LOAN'),
    event: profileLoanEventSchema,
    at: z.iso.datetime(),
    loanId: z.string(),
    role: z.enum(['OWNER', 'BORROWER']),
    counterpart: profileCounterpartSchema,
    work: workSchema.pick({ id: true, title: true }),
  }),
  z.object({
    kind: z.literal('COPIES_ADDED'),
    at: z.iso.datetime(),
    count: z.number().int().positive(),
  }),
])

export type ProfileActivity = z.infer<typeof profileActivitySchema>

export const profileSummarySchema = z.object({
  stats: z.object({
    /** Copies I own now (not archived). */
    copies: countSchema,
    friends: countSchema,
    /** Loans of my copies that were ever handed over — guests included. */
    lentLoans: countSchema,
    wishlist: countSchema,
  }),
  /** How I return books as a borrower (PO decision, 26.10.2026). */
  reliability: z.object({
    /** Returned no later than the due day, out of `returnedWithDue`. */
    returnedOnTime: countSchema,
    /** Returned loans that had a due day; loans without one are not «on time» or «late». */
    returnedWithDue: countSchema,
    /** Mean of `returnedAt − handedAt` over my returned loans, whole days; `null` before the first. */
    averageLoanDays: countSchema.nullable(),
    /** My copies away from home — the same set as `GET /me/library/out`. */
    outNow: countSchema,
  }),
  books: z.object({ items: z.array(profileBookSchema), total: countSchema }),
  friends: z.object({ items: z.array(publicUserSchema), total: countSchema }),
  activity: z.array(profileActivitySchema),
})

export type ProfileSummary = z.infer<typeof profileSummarySchema>
