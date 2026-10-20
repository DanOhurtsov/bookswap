'use client'

import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { useSession } from '@/app/lib/use-session'
import { useReadingStatus } from '../model/use-reading-status'
import { ReadingStatusSelect } from './ReadingStatusSelect'

type ShelfReadingStatusProps = {
  workId: string
  /** The book's title, so that each card's control has a name of its own. */
  title: string
}

/**
 * BS-140: the compact status row at the bottom of an own shelf card. One per card even when the card
 * holds several copies: the status belongs to the work, not to a copy.
 *
 * The row is a sibling of the card's links, never inside one, and it sits above the card's stretched
 * link layer (`relative z-10`): the trigger, the label and the row's empty space do not open the
 * book, and the options open in a portal outside the card.
 */
export function ShelfReadingStatus({ workId, title }: ShelfReadingStatusProps) {
  const { state: session } = useSession()

  // The shelf renders only for a signed-in owner; the check names that for the body below.
  if (session.status !== 'authenticated') return null

  return (
    <ShelfReadingStatusBody
      key={`${session.user.id}:${workId}`}
      userId={session.user.id}
      workId={workId}
      title={title}
    />
  )
}

function ShelfReadingStatusBody({
  userId,
  workId,
  title,
}: ShelfReadingStatusProps & { userId: string }) {
  const { view, retryLoad, save, retrySave } = useReadingStatus({ userId, workId })
  const id = useId()

  return (
    <div className="reading-status reading-status--card relative z-10">
      {view.kind === 'ready' ? <label htmlFor={id}>Читання</label> : <span>Читання</span>}

      {view.kind === 'loading' && <span>Завантажую…</span>}

      {view.kind === 'error' && (
        <>
          <span role="alert">Статус не завантажено.</span>
          <RetryButton title={title} onClick={retryLoad} />
        </>
      )}

      {view.kind === 'ready' && (
        <>
          <ReadingStatusSelect
            id={id}
            label={`Мій статус читання: «${title}»`}
            value={view.current}
            disabled={view.saving !== undefined}
            onChange={save}
          />
          {view.saving !== undefined && <span>Зберігаю…</span>}
          {view.saved !== undefined && <span role="status">Збережено</span>}
          {view.saveError !== undefined && (
            <>
              <span role="alert">Не вдалося зберегти: {view.saveError.message}</span>
              <RetryButton title={title} onClick={retrySave} />
            </>
          )}
        </>
      )}
    </div>
  )
}

function RetryButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Спробувати ще раз: статус читання «${title}»`}
      onClick={onClick}
    >
      Спробувати ще раз
    </Button>
  )
}
