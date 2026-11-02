import { z } from 'zod'
import { workAuthorSchema } from './catalog'
import { publicUserSchema } from './user'

/**
 * BS-147: «Нове в бібліотеках друзів» — `GET /me/friends/new-books`. The newest additions to the
 * libraries of the viewer's friends: at most `total` cards, at most `perFriend` of one friend, so one
 * friend's import of a whole shelf cannot fill the feed alone.
 */
export const FRIENDS_NEW_BOOKS_LIMITS = {
  total: 12,
  perFriend: 3,
} as const

/**
 * One card: a friend and a canonical work they added, by its newest copy that the viewer may see and
 * borrow now. Only what the card shows: the friend as a public user (§9 «Інший»: name, nickname,
 * photo), the work's id and title, its authors, the cover of that copy's edition (`null` — none) and
 * when that copy was added (`Copy.createdAt`).
 */
export const friendsNewBookSchema = z.strictObject({
  friend: z.strictObject(publicUserSchema.shape),
  work: z.strictObject({ id: z.string(), title: z.string() }),
  authors: z.array(z.strictObject(workAuthorSchema.shape)),
  coverUrl: z.string().nullable(),
  addedAt: z.iso.datetime(),
})

export type FriendsNewBook = z.infer<typeof friendsNewBookSchema>

/**
 * `hasFriends` tells «no friends yet» from «friends, but nothing new to show»: both have no `items`.
 * Without friends there can be no items. Newest first.
 */
export const friendsNewBooksResponseSchema = z
  .strictObject({
    hasFriends: z.boolean(),
    items: z.array(friendsNewBookSchema).max(FRIENDS_NEW_BOOKS_LIMITS.total),
  })
  .refine((feed) => feed.hasFriends || feed.items.length === 0, {
    message: 'Без друзів стрічка порожня',
  })

export type FriendsNewBooksResponse = z.infer<typeof friendsNewBooksResponseSchema>
