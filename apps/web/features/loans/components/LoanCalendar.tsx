'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  calendarMonthOf,
  firstDueDay,
  monthOf,
  movedDay,
  shiftMonth,
  type Day,
  type Month,
} from '../model/loan-term'

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] as const

type LoanCalendarProps = {
  today: Day
  value: Day
  shown: Month
  onShow: (month: Month) => void
  onPick: (day: Day) => void
  isLocked: boolean
}

/**
 * The canvas's month grid of the return date. One day takes the Tab stop (the chosen one, else the
 * first that can be chosen); the arrows, Home/End and PageUp/PageDown move it as the APG date picker
 * does, turning the month when they leave it; Enter and Space choose it — it is a plain button.
 */
export function LoanCalendar({ today, value, shown, onShow, onPick, isLocked }: LoanCalendarProps) {
  const month = calendarMonthOf({ shown, today, value })
  const earliest = firstDueDay(today)
  const grid = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<Day | null>(null)
  /** Only a key moves the focus: a preset that redraws the month must leave it where it is. */
  const isMovingByKey = useRef(false)
  const days = month.cells.filter((cell) => cell !== null)
  const stop =
    days.find((cell) => cell.day === cursor) ??
    days.find((cell) => cell.isSelected && !cell.isDisabled) ??
    days.find((cell) => !cell.isDisabled)

  // The cursor moved by a key: the focus follows it, also into a month that has just been drawn.
  useEffect(() => {
    if (!isMovingByKey.current || cursor === null) return
    isMovingByKey.current = false
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${cursor}"]`)?.focus()
  }, [cursor, shown])

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, from: Day) => {
    const next = movedDay(from, event.key)

    if (next === null) return
    event.preventDefault()
    if (next < earliest) return

    isMovingByKey.current = true
    setCursor(next)
    if (monthOf(next).month !== shown.month || monthOf(next).year !== shown.year) {
      onShow(monthOf(next))
    }
  }

  return (
    <div className="loan-calendar">
      <div className="loan-calendar__head">
        <button
          type="button"
          className="loan-calendar__turn"
          aria-label="Попередній місяць"
          disabled={isLocked || !month.canGoBack}
          onClick={() => {
            onShow(shiftMonth(shown, -1))
          }}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </button>
        <span className="loan-calendar__title" aria-live="polite">
          {month.title}
        </span>
        <button
          type="button"
          className="loan-calendar__turn"
          aria-label="Наступний місяць"
          disabled={isLocked}
          onClick={() => {
            onShow(shiftMonth(shown, 1))
          }}
        >
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </div>
      <div className="loan-calendar__weekdays" aria-hidden="true">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div ref={grid} className="loan-calendar__days" role="group" aria-label="Дата повернення">
        {month.cells.map((cell, index) =>
          cell === null ? (
            // Blanks before the 1st only hold the weekday column: they never reorder.
            <span key={`blank-${String(index)}`} aria-hidden="true" />
          ) : (
            <button
              key={cell.day}
              type="button"
              data-day={cell.day}
              className={cn(
                'loan-calendar__day',
                cell.isInTerm && 'loan-calendar__day--term',
                cell.isToday && 'loan-calendar__day--today',
                cell.isSelected && 'loan-calendar__day--due',
              )}
              aria-label={cell.label}
              aria-pressed={cell.isSelected}
              disabled={isLocked || cell.isDisabled}
              tabIndex={cell.day === stop?.day ? 0 : -1}
              onKeyDown={(event) => {
                handleKey(event, cell.day)
              }}
              onClick={() => {
                setCursor(cell.day)
                onPick(cell.day)
              }}
            >
              {cell.date}
            </button>
          ),
        )}
      </div>
      <div className="loan-calendar__legend" aria-hidden="true">
        <span>
          <i className="loan-calendar__swatch loan-calendar__swatch--today" />
          Сьогодні
        </span>
        <span>
          <i className="loan-calendar__swatch loan-calendar__swatch--due" />
          Повернення
        </span>
      </div>
    </div>
  )
}
