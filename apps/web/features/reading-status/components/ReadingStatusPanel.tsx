'use client'

import { useId } from 'react'
import { Chip } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { READING_STATUS_LABELS, WAS_BORROWED_LABEL } from '@/app/lib/labels'
import { useSession } from '@/app/lib/use-session'
import { useReadingStatus } from '../model/use-reading-status'
import { ReadingStatusSelect } from './ReadingStatusSelect'

const HEADING = 'Мій статус читання'

/**
 * Stage 10 (10j.2, §0.15): the viewer's OWN reading status on the work page and on the own-book
 * page. Nobody else's status is shown here or anywhere else (R-8), and there is no list of who read
 * the work.
 *
 * Its failures stay inside this section: a status that cannot be loaded or saved must not take
 * the rest of the page down with it.
 */
export function ReadingStatusPanel({ workId }: { workId: string }) {
  const { state: session } = useSession()

  // The pages render this only for a signed-in viewer; the check names that, so the body below has a
  // real user id instead of a placeholder.
  if (session.status !== 'authenticated') return null

  return (
    <ReadingStatusPanelBody
      key={`${session.user.id}:${workId}`}
      userId={session.user.id}
      workId={workId}
    />
  )
}

function ReadingStatusPanelBody({ userId, workId }: { userId: string; workId: string }) {
  const { view, retryLoad, save, retrySave } = useReadingStatus({ userId, workId })
  const id = useId()

  return (
    <section className="friends-section">
      <h2>{HEADING}</h2>

      {view.kind === 'loading' && <p className="status status--pending">Завантажую статус…</p>}

      {view.kind === 'error' && (
        <div role="alert">
          <p className="status status--error">{view.message}</p>
          <button type="button" onClick={retryLoad}>
            Спробувати ще раз
          </button>
        </div>
      )}

      {view.kind === 'ready' && (
        <>
          <div className="reading-status">
            <ReadingStatusSelect
              id={id}
              label={HEADING}
              value={view.current}
              disabled={view.saving !== undefined}
              onChange={save}
            />
          </div>

          {view.wasBorrowed && (
            <div className="chips">
              <Chip>{WAS_BORROWED_LABEL}</Chip>
            </div>
          )}

          <p className="form__aside">Статус бачите лише ви.</p>

          {view.saving !== undefined && <p className="status status--pending">Зберігаю…</p>}

          <FormStatus
            error={view.saveError}
            success={
              view.saved === undefined
                ? undefined
                : `Збережено: «${READING_STATUS_LABELS[view.saved]}».`
            }
          />

          {view.failed !== undefined && (
            <button type="button" onClick={retrySave}>
              Спробувати ще раз
            </button>
          )}
        </>
      )}
    </section>
  )
}
