'use client'

import Link from 'next/link'
import { useId } from 'react'
import { BookOpenIcon, CircleAlertIcon } from 'lucide-react'
import type { ReadingStatsResponse } from '@bookswap/shared'
import { assertNever } from '@/app/lib/assert-never'
import { useSession } from '@/app/lib/use-session'
import { SECTION_NOTICE_LINK, SectionNotice } from '@/components/SectionNotice'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ReadingStatsSnapshot, ReadingStatsView } from '../model/reading-stats-view'
import { useReadingStats } from '../model/use-reading-stats'

type HomeReadingStatsProps = {
  /** What the server read before the page was sent. */
  initial: ReadingStatsSnapshot
}

/**
 * BS-145: the viewer's reading stats on the public home page. A guest sees nothing and asks for
 * nothing.
 *
 * The server's snapshot is neither shown nor cached until the browser has confirmed whose tab this
 * is: should the session have changed since the page was rendered, the snapshot belongs to someone
 * else. Once the session is known, the body is mounted for that user and reads the stats through the
 * cache, seeded with the snapshot only if it was read for that same user — then without a request.
 */
export function HomeReadingStats({ initial }: HomeReadingStatsProps) {
  const { state: session } = useSession()

  // A session error is reported where the session is owned; a second copy here helps nobody.
  if (session.status === 'guest' || session.status === 'error') return null

  if (session.status === 'loading') {
    // The server already knows there is no session; a loading block would flash at a guest.
    return initial.status === 'guest' ? null : <ReadingStatsSection view={{ kind: 'loading' }} />
  }

  const userId = session.user.id

  return (
    <HomeReadingStatsBody
      key={userId}
      userId={userId}
      seed={initial.status === 'ready' && initial.userId === userId ? initial.data : undefined}
    />
  )
}

function HomeReadingStatsBody({
  userId,
  seed,
}: {
  userId: string
  seed: ReadingStatsResponse | undefined
}) {
  const { view, retry } = useReadingStats({ userId, seed })

  return <ReadingStatsSection view={view} onRetry={retry} />
}

function ReadingStatsSection({ view, onRetry }: { view: ReadingStatsView; onRetry?: () => void }) {
  const headingId = useId()

  return (
    <section
      className="home-section reading-stats"
      aria-labelledby={headingId}
      aria-busy={view.kind === 'loading'}
    >
      <h2 id={headingId} className="home-section__title">
        Моє читання
      </h2>
      <ReadingStatsBody view={view} onRetry={onRetry} />
    </section>
  )
}

function ReadingStatsBody({
  view,
  onRetry,
}: {
  view: ReadingStatsView
  onRetry: (() => void) | undefined
}) {
  switch (view.kind) {
    case 'loading':
      // The placeholders hold the cards' places; the text says the same to a screen reader.
      return (
        <>
          <p className="sr-only">Рахую ваші статуси читання…</p>
          <div className="reading-stats__list" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="reading-stats__placeholder" />
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
            onRetry !== undefined && (
              <Button variant="outline" className="section-notice__button" onClick={onRetry}>
                Спробувати ще раз
              </Button>
            )
          }
        />
      )

    case 'empty':
      return (
        <SectionNotice
          icon={BookOpenIcon}
          title="Ви ще не позначили жодного твору."
          text="Статус читання можна вказати на картках у бібліотеці."
          action={
            <Link className={SECTION_NOTICE_LINK} href="/library">
              Перейти до бібліотеки
            </Link>
          }
        />
      )

    case 'ready':
      // Three cards from a tablet up, one card of three rows on a phone (canvas «Main Page»).
      return (
        <>
          <dl className="reading-stats__list">
            {view.items.map((item) => (
              <div key={item.status} className="reading-stats__item">
                <dt>{item.label}</dt>
                <dd className="reading-stats__count">{item.count}</dd>
              </div>
            ))}
          </dl>
          <p className="reading-stats__note">Кількість творів. Статистику бачите лише ви.</p>
        </>
      )

    default:
      return assertNever(view)
  }
}
