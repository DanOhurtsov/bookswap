'use client'

import Link from 'next/link'
import { useId } from 'react'
import { assertNever } from '@/app/lib/assert-never'
import { useSession } from '@/app/lib/use-session'
import { BookCover } from '@/components/BookCover'
import { AuthorLine } from '@/components/BookParts'
import { UserAvatar } from '@/components/Friends/UserAvatar'
import { buttonVariants } from '@/components/ui/button'
import { USER_SEARCH_PATH } from '@/features/user-search/index.client'
import type { FriendsReadingCard, FriendsReadingView } from '../model/friends-reading-view'
import { useFriendsReading } from '../model/use-friends-reading'

/**
 * BS-137: «Що читають мої друзі» on the home page. A guest — and a session not yet known or failed —
 * sees nothing and asks for nothing: the feed is private, and its request is sent only below this
 * guard, for the signed-in user, in a body keyed by that user.
 */
export function FriendsReading() {
  const { state: session } = useSession()

  if (session.status !== 'authenticated') return null

  return <FriendsReadingBody key={session.user.id} userId={session.user.id} />
}

function FriendsReadingBody({ userId }: { userId: string }) {
  const { view, retry } = useFriendsReading(userId)
  const headingId = useId()

  return (
    <section
      className="friends-reading"
      aria-labelledby={headingId}
      aria-busy={view.kind === 'loading'}
    >
      <h2 id={headingId} className="friends-reading__title">
        Що читають мої друзі
      </h2>
      <FriendsReadingContent view={view} onRetry={retry} />
    </section>
  )
}

function FriendsReadingContent({
  view,
  onRetry,
}: {
  view: FriendsReadingView
  onRetry: () => void
}) {
  switch (view.kind) {
    case 'loading':
      return (
        <p className="status status--pending" role="status">
          Дивлюся, що читають друзі…
        </p>
      )

    case 'error':
      return (
        <div className="status status--error" role="alert">
          <p>{view.message}</p>
          <button type="button" className="button--ghost" onClick={onRetry}>
            Спробувати ще раз
          </button>
        </div>
      )

    case 'no-friends':
      return (
        <>
          <p>Додайте друзів, щоб бачити, що вони зараз читають.</p>
          <p className="actions">
            <Link href={USER_SEARCH_PATH} className={buttonVariants()}>
              Знайти друзів
            </Link>
          </p>
        </>
      )

    case 'nobody-reading':
      return <p>Зараз ніхто з ваших друзів нічого не читає.</p>

    case 'ready':
      return (
        // The grid of the catalog (BS-134): `.result-grid` alone owns the 1–4 column thresholds.
        <div className="result-grid">
          <ul>
            {view.cards.map((card) => (
              <FriendReadingCard key={card.key} card={card} />
            ))}
          </ul>
        </div>
      )

    default:
      return assertNever(view)
  }
}

/**
 * The frame of a catalog result card (`ResultCardShell`), with two separate links and nothing nested:
 * the title opens the work, the friend opens their library. The cover is not a link — the title beside
 * it is the one way to the work, so a keyboard meets each target once.
 */
function FriendReadingCard({ card }: { card: FriendsReadingCard }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-(--line) px-4 py-[0.9rem]">
      <div className="flex justify-center">
        <BookCover url={card.coverUrl} alt={card.coverAlt} variant="card" />
      </div>

      {/* In a grid column a title or an author with no spaces must break, not widen the card. */}
      <div className="grid min-w-0 content-start justify-items-start gap-1 wrap-anywhere">
        <Link className="book__title" href={card.workHref}>
          {card.title}
        </Link>
        <AuthorLine authors={card.authors} />
      </div>

      <p className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.9rem]">
        <span className="text-(--bookswap-muted)">Читає</span>
        <Link
          href={card.friendHref}
          className="flex min-w-0 items-center gap-2 font-medium wrap-anywhere"
        >
          {/* The initials repeat the name beside them; read aloud, the link would say «М Марта». */}
          <span aria-hidden="true">
            <UserAvatar user={card.friend} />
          </span>
          <span className="min-w-0">{card.friend.displayName}</span>
        </Link>
      </p>
    </li>
  )
}
