'use client'

import { useId } from 'react'
import { CircleAlertIcon } from 'lucide-react'
import { LOAN_LIMITS } from '@bookswap/shared'
import { localDay, shortDay, type Day } from '../model/loan-term'
import { answerFailureText, ownerTermHint } from '../model/owner-request-view'
import type { ApproveFormState } from '../model/use-approve-form'
import { LoanTermField } from './LoanTermField'

type OwnerAnswerFieldsProps = {
  form: ApproveFormState
  /** The borrower's date, if they asked for one. */
  requested: Day | null
  isLocked: boolean
  /** The last attempt's failure, said under the fields; `undefined` or `null` when there is none. */
  failure: unknown
}

/**
 * The owner's answer to a request: the term and a note, and what went wrong with the last attempt. The
 * same fields on `/loans?loanId=` and on the home page (BS-147), so an approval reads and sends the
 * same from either. The values are the caller's form: they outlive a failed attempt.
 */
export function OwnerAnswerFields({ form, requested, isLocked, failure }: OwnerAnswerFieldsProps) {
  const noteId = useId()
  const countId = useId()

  return (
    <>
      <LoanTermField
        value={form.dueAt}
        onChange={form.setDueAt}
        today={localDay(new Date())}
        requested={requested}
        hint={ownerTermHint(requested)}
        empty={{ title: 'Без дати', text: 'Позика буде без дати повернення.' }}
        canClear={requested === null}
        isLocked={isLocked}
      >
        {(setDay) =>
          requested !== null &&
          form.dueAt !== requested && (
            <div className="loan-term__changed">
              <span className="loan-term__changed-title">Ви змінили дату</span>
              <span className="loan-term__changed-text">У запиті — до {shortDay(requested)}.</span>
              <button
                type="button"
                className="loan-term__link"
                onClick={() => {
                  setDay(requested)
                }}
              >
                Повернути як у запиті
              </button>
            </div>
          )
        }
      </LoanTermField>

      <div className="loan-note">
        <div className="loan-note__head">
          <label htmlFor={noteId} className="loan-note__label">
            Повідомлення до погодження <span>(необовʼязково)</span>
          </label>
          <span id={countId} className="loan-note__count">
            {form.note.length}/{LOAN_LIMITS.noteMax}
          </span>
        </div>
        <textarea
          id={noteId}
          className="loan-note__field"
          aria-describedby={countId}
          maxLength={LOAN_LIMITS.noteMax}
          placeholder="Наприклад, де й коли зручно передати книжку"
          value={form.note}
          disabled={isLocked}
          onChange={(event) => {
            form.setNote(event.target.value)
          }}
        />
      </div>

      {failure !== undefined && failure !== null && (
        <div className="loan-alert" role="alert">
          <CircleAlertIcon aria-hidden="true" />
          <p>{answerFailureText(failure)}</p>
        </div>
      )}
    </>
  )
}
