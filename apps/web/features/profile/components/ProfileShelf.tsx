import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { PlaceTone, ProfileBookCard } from '../model/profile-view'
import { EmptySection, SeeAllLink } from './ProfileParts'
import { ShelfCover } from './ShelfCover'

/** The dot repeats the text's meaning in colour; the text alone already says it. */
const DOT: Record<PlaceTone, string> = {
  home: 'bg-(--ok)',
  requested: 'bg-(--warn)',
  out: 'bg-[#4a7bb0]',
  overdue: 'bg-(--error)',
  muted: 'bg-(--bookswap-muted)',
}

const TEXT: Record<PlaceTone, string> = {
  home: 'text-(--ok)',
  requested: 'text-(--warn)',
  out: 'text-(--bookswap-muted)',
  overdue: 'text-(--error)',
  muted: 'text-(--bookswap-muted)',
}

/**
 * «Мої книжки»: the latest copies and where each one is. A rail that scrolls sideways on a phone,
 * six in a row from a tablet up (canvas «Profile Page», «Мої книжки»).
 */
export function ProfileShelf({ books }: { books: { cards: ProfileBookCard[]; total: number } }) {
  return (
    <section aria-labelledby="profile-shelf" className="flex min-w-0 flex-col gap-2 md:gap-3">
      <div className="flex items-center justify-between gap-4">
        <h2
          id="profile-shelf"
          className="m-0 text-xl leading-7 font-semibold md:text-[22px] md:leading-[30px]"
        >
          Мої книжки
        </h2>
        {books.total > 0 && <SeeAllLink href="/library">Усі {books.total}</SeeAllLink>}
      </div>

      {books.cards.length === 0 ? (
        <EmptySection
          title="Полиця порожня"
          text="Додайте книжки, якими готові ділитися."
          action={
            <Link className="link-underline" href="/catalog/new">
              Додати книжку
            </Link>
          }
        />
      ) : (
        // The rail scrolls on its own, so it clips: the room around the covers keeps a lifted cover,
        // its shadow and its focus ring inside it. The negative margins give that room back.
        <ul className="-mx-2 my-0 flex list-none snap-x scroll-px-2 gap-4 overflow-x-auto px-2 pt-2 pb-6 md:mx-0 md:grid md:grid-cols-6 md:gap-x-[18px] md:gap-y-6 md:overflow-visible md:px-0 md:pt-1 md:pb-2">
          {books.cards.map((card) => (
            <li key={card.key} className="w-[104px] shrink-0 snap-start md:w-auto">
              <Link
                href={card.href}
                aria-label={card.ariaLabel}
                className="profile-book flex flex-col gap-2 text-inherit no-underline"
              >
                <ShelfCover
                  bookId={card.bookId}
                  url={card.coverUrl}
                  title={card.title}
                  authors={card.authors}
                />
                <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                  <span className="truncate text-sm leading-5 font-semibold">{card.title}</span>
                  <span className="inline-flex items-start gap-1.5 text-[13px] leading-[18px]">
                    {/* On the first line of a place that wraps, not halfway down it. */}
                    <i
                      aria-hidden="true"
                      className={cn(
                        'mt-[5.5px] size-[7px] shrink-0 rounded-full',
                        DOT[card.place.tone],
                      )}
                    />
                    <span className={TEXT[card.place.tone]}>{card.place.text}</span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
