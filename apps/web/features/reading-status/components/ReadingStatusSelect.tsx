'use client'

import { READING_STATUS, type ReadingStatus } from '@bookswap/shared'
import { sameOption, labelledOptions } from '@/components/Form/FormFields'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { READING_STATUS_LABELS } from '@/app/lib/labels'

const OPTIONS = labelledOptions(READING_STATUS, READING_STATUS_LABELS)

/** Shown while nothing is set — not «Не читав», which is a status of its own (BS-140). */
const READING_STATUS_PLACEHOLDER = 'Вказати статус читання'

type ReadingStatusSelectProps = {
  id: string
  /** The trigger's accessible name; it contains the visible label, if there is one. */
  label: string
  /** `null` — not set. */
  value: ReadingStatus | null
  disabled: boolean
  onChange: (status: ReadingStatus) => void
}

/**
 * The one control for a personal reading status, on the shelf cards and on both book pages. The list
 * opens in a portal, so its options are never inside a card and never reach the card's link.
 */
export function ReadingStatusSelect({
  id,
  label,
  value,
  disabled,
  onChange,
}: ReadingStatusSelectProps) {
  return (
    <Select
      value={OPTIONS.find((option) => option.value === value) ?? null}
      isItemEqualToValue={sameOption}
      disabled={disabled}
      onValueChange={(option) => {
        if (option !== null) onChange(option.value)
      }}
    >
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue placeholder={READING_STATUS_PLACEHOLDER} />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
