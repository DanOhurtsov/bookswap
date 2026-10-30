'use client'

import Link from 'next/link'
import { useId } from 'react'
import { BookOpenIcon, CircleAlertIcon } from 'lucide-react'
import { assertNever } from '@/app/lib/assert-never'
import { useMediaQuery } from '@/app/lib/use-media-query'
import { useSession } from '@/app/lib/use-session'
import { getInitials } from '@/components/Friends/UserAvatar'
import { SECTION_NOTICE_LINK, SectionNotice } from '@/components/SectionNotice'
import { ShelfCover } from '@/components/ShelfCover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  useCarousel,
} from '@/components/ui/carousel'
import { Skeleton } from '@/components/ui/skeleton'
import type { FriendsNewBookCard, FriendsNewBooksView } from '../model/friends-new-books-view'
import { useFriendsNewBooks } from '../model/use-friends-new-books'

/** Where friends are invited: the invitations live on the friends page (`InviteManager`). */
const INVITE_HREF = '/friends'

/**
 * BS-147: «Нове в бібліотеках друзів» on the home page (canvas «Main Page»). A guest — and a session not
 * yet known or failed — sees nothing and asks for nothing: the feed is private, and its request is sent
 * only below this guard, for the signed-in user, in a body keyed by that user.
 */
export function FriendsNewBooks() {
  const { state: session } = useSession()

  if (session.status !== 'authenticated') return null

  return <FriendsNewBooksBody key={session.user.id} userId={session.user.id} />
}

function FriendsNewBooksBody({ userId }: { userId: string }) {
  const { view, retry } = useFriendsNewBooks(userId)
  const headingId = useId()

  if (view.kind === 'ready') return <NewBooksCarousel cards={view.cards} headingId={headingId} />

  return (
    <section
      className="home-section"
      aria-labelledby={headingId}
      aria-busy={view.kind === 'loading'}
    >
      <SectionTitle id={headingId} />
      <NewBooksNotice view={view} onRetry={retry} />
    </section>
  )
}

/**
 * The canvas shortens the heading on a phone. The full one stays in the accessibility tree at every
 * width, so the section has one name wherever it is read.
 */
function SectionTitle({ id }: { id: string }) {
  return (
    <h2 id={id} className="home-section__title">
      <span aria-hidden="true" className="md:hidden">
        Нове в друзів
      </span>
      <span className="max-md:sr-only">Нове в бібліотеках друзів</span>
    </h2>
  )
}

function NewBooksNotice({
  view,
  onRetry,
}: {
  view: Exclude<FriendsNewBooksView, { kind: 'ready' }>
  onRetry: () => void
}) {
  switch (view.kind) {
    case 'loading':
      // The placeholders hold the covers' places; the text says the same to a screen reader.
      return (
        <>
          <p className="sr-only">Шукаю нові книжки друзів…</p>
          <div className="flex gap-4 overflow-hidden pt-1 md:gap-5" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                className={`${CARD_WIDTH} flex shrink-0 flex-col gap-2 lg:w-[calc((100%-100px)/6)]`}
              >
                <Skeleton className="aspect-2/3 w-full rounded-[4px_8px_8px_4px]" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ))}
          </div>
        </>
      )

    case 'error':
      return (
        <SectionNotice
          role="alert"
          icon={CircleAlertIcon}
          title={view.message}
          action={
            <Button variant="outline" className="section-notice__button" onClick={onRetry}>
              Спробувати ще раз
            </Button>
          }
        />
      )

    case 'empty':
      return (
        <SectionNotice
          icon={BookOpenIcon}
          title="Друзі ще нічого не додали"
          text="Запросіть більше друзів, щоб бачити нові книжки."
          action={
            <Link className={SECTION_NOTICE_LINK} href={INVITE_HREF}>
              Запросити
            </Link>
          }
        />
      )

    default:
      return assertNever(view)
  }
}

/**
 * A card's width below a desktop, from the canvas: 116 px on a phone, 140 px on a tablet. From a desktop
 * up six fit in a row — the canvas's `(100% − 100px) / 6` with 20 px gaps.
 */
const CARD_WIDTH = 'w-[116px] md:w-[140px]'

/**
 * The feed as a carousel: no autoplay and no loop, so it moves only when the reader moves it. Arrows
 * from a tablet up, a swipe on touch, ←/→ from inside it (the shadcn root listens), and Tab scrolls the
 * focused card into view (Embla's `watchFocus`). With reduced motion every move is a jump.
 */
function NewBooksCarousel({
  cards,
  headingId,
}: {
  cards: FriendsNewBookCard[]
  headingId: string
}) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const trackId = useId()

  return (
    <Carousel
      // The shadcn root is the labelled region: the arrows need its context, the heading names it.
      className="home-section"
      aria-labelledby={headingId}
      opts={{ align: 'start', slidesToScroll: 'auto', ...(reducedMotion && { duration: 0 }) }}
    >
      <div className="flex items-center justify-between gap-4">
        <SectionTitle id={headingId} />
        <CarouselArrows trackId={trackId} />
      </div>
      {/* The viewport clips: its padding is room for a lifted cover, its shadow and its focus ring,
          and the negative margin gives that room back to the page. Below a desktop the rail runs to
          the screen's edges, as on the canvas: the room is the page's gutter. */}
      <CarouselContent
        id={trackId}
        viewportClassName="-mx-(--page-gutter) -mt-3 -mb-4 px-(--page-gutter) pt-3 pb-4 lg:-mx-2 lg:px-2"
        className="-ml-4 md:-ml-5"
      >
        {cards.map((card) => (
          // The gap is the slide's left padding — Embla measures slides, not `gap` — and the track's
          // negative margin takes the first one back: six slides of `(100% + 20px) / 6` hold six cards
          // of the canvas width.
          <CarouselItem key={card.key} className="basis-auto pl-4 md:pl-5 lg:basis-1/6">
            <NewBookCard card={card} />
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>
  )
}

/** Nothing to scroll — every card already in view — no arrows. */
function CarouselArrows({ trackId }: { trackId: string }) {
  const { canScrollPrev, canScrollNext } = useCarousel()

  if (!canScrollPrev && !canScrollNext) return null

  return (
    <div className="hidden gap-2 md:flex">
      <CarouselPrevious
        aria-label="Попередні книжки"
        aria-controls={trackId}
        className="static size-11 translate-none [&_svg]:size-5"
      />
      <CarouselNext
        aria-label="Наступні книжки"
        aria-controls={trackId}
        className="static size-11 translate-none [&_svg]:size-5"
      />
    </div>
  )
}

/**
 * The whole card is one link to the work; the friend is a caption inside it, never a second target
 * (PO decision, 30.10.2026). The canvas drops the author on a phone and the avatar below a desktop.
 */
function NewBookCard({ card }: { card: FriendsNewBookCard }) {
  return (
    <Link
      href={card.href}
      aria-label={card.ariaLabel}
      className={`friend-new-book flex flex-col gap-2 text-inherit no-underline lg:w-full lg:gap-2.5 ${CARD_WIDTH}`}
    >
      <ShelfCover
        bookId={card.bookId}
        url={card.coverUrl}
        title={card.title}
        authors={card.authors}
      />
      <span className="flex min-w-0 flex-col gap-0.5 pt-0.5 lg:pt-1">
        <span className="line-clamp-2 text-sm leading-[19px] font-semibold wrap-anywhere md:text-[15px] md:leading-5 lg:leading-[21px]">
          {card.title}
        </span>
        {card.authors !== '' && (
          <span className="hidden truncate text-[13px] leading-[18px] text-(--bookswap-muted) md:block lg:text-sm lg:leading-5">
            {card.authors}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-(--bookswap-muted) lg:mt-1 lg:text-[13px] lg:leading-[18px]">
          <Avatar className="hidden size-5 lg:flex">
            {card.friend.avatarUrl !== null && <AvatarImage src={card.friend.avatarUrl} alt="" />}
            <AvatarFallback className="text-[10px]">
              {getInitials(card.friend.displayName)}
            </AvatarFallback>
          </Avatar>
          {/* The name gives way; the time keeps its width, and is cut only when it alone is wider than
              the line (200 % text). */}
          <span className="flex min-w-0">
            <span className="min-w-0 truncate">{card.friend.displayName}</span>
            <span className="max-w-full shrink-0 truncate">
              {'\u00a0· '}
              <time dateTime={card.addedAt}>{card.addedAgo}</time>
            </span>
          </span>
        </span>
      </span>
    </Link>
  )
}
