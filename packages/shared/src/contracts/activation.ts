import { z } from 'zod'

/**
 * Stage 8h, R11: progress towards the first ten books.
 *
 * `GET /api/v1/me/activation` answers one question — how far the owner still is
 * from a shelf worth inviting friends to — and R11 names all four fields the
 * answer carries. Three of them are derivable from `ownedCopyCount`, and that
 * redundancy is deliberate: where BookSwap stops asking for books and starts
 * asking for friends is a product rule, and a client that recomputes it locally
 * is a second place for that rule to drift.
 *
 * The count comes from domain `Copy` rows, never from `BOOK_ADDED` analytics
 * (§1 of the execution plan). Those events are best-effort and only ever grow,
 * while deleting a copy really does move the owner further from ten.
 */

/** R11: ten books is what makes a library usable for somebody else. */
export const ACTIVATION_TARGET = 10

/**
 * What BookSwap asks the owner to do next.
 *
 * A closed pair rather than a free string: each value maps to exactly one
 * existing screen, and a union is what turns a third value into a compile error
 * instead of a button that leads nowhere. Invite links belong to Stage 9 —
 * `INVITE_FRIENDS` points at the friends page that already exists and promises
 * nothing beyond it.
 */
export const ACTIVATION_NEXT_ACTION = ['ADD_BOOKS', 'INVITE_FRIENDS'] as const

export const activationNextActionSchema = z.enum(ACTIVATION_NEXT_ACTION)

export type ActivationNextAction = z.infer<typeof activationNextActionSchema>

/**
 * The threshold rule itself, exported so that the server building the response
 * and the schema judging it read the same line of code. Two copies of `>= 10`
 * would be two chances to disagree about the tenth book.
 */
export function hasReachedActivationTarget(ownedCopyCount: number): boolean {
  return ownedCopyCount >= ACTIVATION_TARGET
}

export function activationNextActionFor(ownedCopyCount: number): ActivationNextAction {
  return hasReachedActivationTarget(ownedCopyCount) ? 'INVITE_FRIENDS' : 'ADD_BOOKS'
}

/**
 * Strict, and internally consistent or invalid.
 *
 * The refinements are not decoration: with four fields that must agree, a
 * response saying «9 books, go invite friends» parses fine field by field and
 * is still nonsense. Checking the agreement here means the web client cannot
 * render it, and the API's own tests cannot claim it passes.
 */
export const activationResponseSchema = z
  .strictObject({
    ownedCopyCount: z.number().int().nonnegative(),
    /**
     * `z.literal`, not `z.number().int().positive()`: the target is part of the
     * contract, not a number the server picks per response. Raising it one day
     * fails here loudly instead of quietly teaching one client a different
     * finish line than the others.
     */
    target: z.literal(ACTIVATION_TARGET),
    hasReachedTarget: z.boolean(),
    nextAction: activationNextActionSchema,
  })
  .superRefine((progress, context) => {
    if (progress.hasReachedTarget !== hasReachedActivationTarget(progress.ownedCopyCount)) {
      context.addIssue({
        code: 'custom',
        message: `hasReachedTarget must be ownedCopyCount >= ${String(ACTIVATION_TARGET)}`,
        path: ['hasReachedTarget'],
      })
    }

    if (progress.nextAction !== activationNextActionFor(progress.ownedCopyCount)) {
      context.addIssue({
        code: 'custom',
        message: `nextAction must be ${activationNextActionFor(progress.ownedCopyCount)} at ${String(progress.ownedCopyCount)} copies`,
        path: ['nextAction'],
      })
    }
  })

export type ActivationResponse = z.infer<typeof activationResponseSchema>
