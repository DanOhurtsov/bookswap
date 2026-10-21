'use client'

import Link from 'next/link'
import { useId } from 'react'
import type { ReadingStatsResponse } from '@bookswap/shared'
import { assertNever } from '@/app/lib/assert-never'
import { useSession } from '@/app/lib/use-session'
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
      className="reading-stats"
      aria-labelledby={headingId}
      aria-busy={view.kind === 'loading'}
    >
      <h2 id={headingId} className="reading-stats__title">
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
      return <p className="status status--pending">Рахую ваші статуси читання…</p>

    case 'error':
      return (
        <div className="status status--error" role="alert">
          <p>{view.message}</p>
          {onRetry !== undefined && (
            <button type="button" className="button--ghost" onClick={onRetry}>
              Спробувати ще раз
            </button>
          )}
        </div>
      )

    case 'empty':
      return (
        <>
          <p>
            Ви ще не позначили жодного твору. Статус читання можна вказати на картках у бібліотеці.
          </p>
          <p className="actions">
            <Link className="reading-stats__cta" href="/library">
              Перейти до бібліотеки
            </Link>
          </p>
        </>
      )

    case 'ready':
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
          <p className="form__aside">Кількість творів. Статистику бачите лише ви.</p>
        </>
      )

    default:
      return assertNever(view)
  }
}
