'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  NO_DAY,
  monthOf,
  shortDay,
  termFromToday,
  termOptionsOf,
  type Day,
  type Month,
} from '../model/loan-term'
import { LoanCalendar } from './LoanCalendar'

type LoanTermFieldProps = {
  value: Day
  onChange: (day: Day) => void
  today: Day
  /** The borrower's date, on the owner's side: its preset says «за запитом». */
  requested?: Day | null
  /** Under the legend: whose term this is and who has the last word. */
  hint: string
  /** What the summary says while no date is chosen. */
  empty: { title: string; text: string }
  /** «Без дати» as the first option: offered only where sending no date means something. */
  canClear: boolean
  isLocked: boolean
  /** Below the summary: the owner's «Ви змінили термін», given a way to set a date as a preset would. */
  children?: (setDay: (day: Day) => void) => ReactNode
}

/**
 * The canvas's «Термін позики»: the presets as one radio group, the month and the chosen date beside
 * it. The value is the parent's (a request's or an approval's field); which option was pressed and
 * which month is open are only this control's.
 */
export function LoanTermField({
  value,
  onChange,
  today,
  requested = null,
  hint,
  empty,
  canClear,
  isLocked,
  children,
}: LoanTermFieldProps) {
  const hintId = useId()
  const summaryId = useId()
  const [isCustom, setIsCustom] = useState(false)
  // `null`: the month of the date (or of today). A turn of the page keeps its own month.
  const [turned, setTurned] = useState<Month | null>(null)
  const options = termOptionsOf({ today, value, isCustom, requested, canClear })
  const radios = useRef<HTMLDivElement>(null)
  const shown = turned ?? monthOf(value === NO_DAY ? today : value)
  const stop = options.find((option) => option.isChecked) ?? options[0]

  const choose = (key: string) => {
    const option = options.find((candidate) => candidate.key === key)

    if (option === undefined) return
    setIsCustom(option.day === null)
    setTurned(null)
    if (option.day !== null) onChange(option.day)
  }

  // A radio group moves its choice with the arrows (APG): Tab enters it once, at the checked one.
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]

    if (step === undefined) return
    event.preventDefault()

    const next = options[(index + step + options.length) % options.length]

    if (next === undefined) return
    choose(next.key)
    radios.current?.querySelector<HTMLButtonElement>(`[data-term="${next.key}"]`)?.focus()
  }

  return (
    <fieldset className="loan-term" aria-describedby={hintId} disabled={isLocked}>
      <legend className="loan-term__legend">Термін позики</legend>
      <p id={hintId} className="loan-term__hint">
        {hint}
      </p>
      <div
        ref={radios}
        className="loan-term__options"
        role="radiogroup"
        aria-label="Тривалість позики"
      >
        {options.map((option, index) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            data-term={option.key}
            className={cn('loan-term__option', option.isChecked && 'loan-term__option--on')}
            aria-checked={option.isChecked}
            tabIndex={option.key === stop?.key ? 0 : -1}
            onKeyDown={(event) => {
              handleKey(event, index)
            }}
            onClick={() => {
              choose(option.key)
            }}
          >
            <b>{option.label}</b>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>
      <div className="loan-term__body">
        <LoanCalendar
          today={today}
          value={value}
          shown={shown}
          onShow={setTurned}
          onPick={(day) => {
            setIsCustom(false)
            onChange(day)
          }}
          isLocked={isLocked}
        />
        <div className="loan-term__summary" role="group" aria-labelledby={summaryId}>
          <span id={summaryId} className="loan-term__summary-label">
            Повернути до
          </span>
          <span className="loan-term__due" aria-live="polite">
            {value === NO_DAY ? empty.title : shortDay(value)}
          </span>
          <span className="loan-term__distance">
            {value === NO_DAY ? empty.text : termFromToday(today, value)}
          </span>
          {children?.((day) => {
            setIsCustom(false)
            setTurned(null)
            onChange(day)
          })}
        </div>
      </div>
    </fieldset>
  )
}
