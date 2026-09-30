'use client'

import { READING_STATUS } from '@bookswap/shared'
import { Chip } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { READING_STATUS_LABELS, WAS_BORROWED_LABEL } from '@/app/lib/labels'
import { useReadingStatus } from '../model/use-reading-status'

/**
 * Stage 10 (10j.2, §0.15): the viewer's OWN reading status on the work page. Nobody else's status
 * is shown here or anywhere else (R-8), and there is no list of who read the work.
 *
 * Its failures stay inside this section: a status that cannot be loaded or saved must not take
 * the rest of the work page down with it.
 */
export function ReadingStatusPanel({ workId }: { workId: string }) {
  const { state, reload, saving, saved, saveError, failed, save } = useReadingStatus(workId)

  return (
    <section className="friends-section">
      <h2>Мій статус читання</h2>

      {state.status === 'loading' && <p className="status status--pending">Завантажую статус…</p>}

      {state.status === 'error' && (
        <div role="alert">
          <p className="status status--error">{state.message}</p>
          <button type="button" onClick={reload}>
            Спробувати ще раз
          </button>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="actions" role="group" aria-label="Мій статус читання">
            {READING_STATUS.map((value) => {
              const current = state.data.status === value

              return (
                <button
                  key={value}
                  type="button"
                  className={current ? undefined : 'button--ghost'}
                  aria-pressed={current}
                  disabled={saving !== undefined}
                  onClick={() => {
                    if (!current) void save(value)
                  }}
                >
                  {READING_STATUS_LABELS[value]}
                </button>
              )
            })}
          </div>

          {state.data.wasBorrowed && (
            <div className="chips">
              <Chip>{WAS_BORROWED_LABEL}</Chip>
            </div>
          )}

          <p className="form__aside">Статус бачите лише ви.</p>

          {saving !== undefined && <p className="status status--pending">Зберігаю…</p>}

          <FormStatus
            error={saveError}
            success={
              saved === undefined ? undefined : `Збережено: «${READING_STATUS_LABELS[saved]}».`
            }
          />

          {failed !== undefined && (
            <button type="button" onClick={() => void save(failed)}>
              Спробувати ще раз
            </button>
          )}
        </>
      )}
    </section>
  )
}
