'use client'

import { useMutation } from '@tanstack/react-query'
import type { LoanTermDays, Me, UpdateProfileRequest } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { updateProfile } from '../api/profile-requests'
import { savedFields } from './saved-fields'

/** «Термін за замовчуванням»: three terms, or «Власна дата» — `null`, the approve form prefills nothing. */
export const LOAN_TERM_CHOICES = [
  { value: '14', label: '2 тижні' },
  { value: '21', label: '3 тижні' },
  { value: '30', label: '1 місяць' },
  { value: 'custom', label: 'Власна дата' },
] as const

export type LoanTermChoice = (typeof LOAN_TERM_CHOICES)[number]['value']

export function loanTermChoiceOf(days: LoanTermDays | null): LoanTermChoice {
  return days === null ? 'custom' : `${days}`
}

export function loanTermDaysOf(choice: LoanTermChoice): LoanTermDays | null {
  switch (choice) {
    case '14':
      return 14
    case '21':
      return 21
    case '30':
      return 30
    case 'custom':
      return null
  }
}

export interface ProfileSettingsController {
  /** The profile as the settings show it: while a change is being saved, with that change in. */
  shown: Me
  save: (changes: UpdateProfileRequest) => void
  /** One change at a time: the controls wait for the answer, so two answers never cross. */
  saving: boolean
  /** The failure of the last change, told only by the card whose field it was. */
  errorFor: (fields: readonly (keyof UpdateProfileRequest)[]) => string | undefined
}

/**
 * BS-148 (PROF-08): a setting is saved the moment it changes. The new value is shown at once and
 * dropped if the server refuses it — `shown` is the saved profile plus the change in flight, never a
 * copy that could drift from the session. Both settings cards share one controller.
 */
export function useProfileSettings(
  user: Me,
  onSaved: (changes: Partial<Me>) => void,
): ProfileSettingsController {
  const mutation = useMutation({
    mutationFn: (body: UpdateProfileRequest) => updateProfile(body),
    onSuccess: (saved, changes) => {
      onSaved(savedFields(saved, changes))
    },
  })
  const pending = mutation.isPending ? mutation.variables : undefined

  return {
    shown: pending === undefined ? user : { ...user, ...pending },
    save: (changes) => {
      mutation.mutate(changes)
    },
    saving: mutation.isPending,
    errorFor: (fields) => {
      const failed = mutation.isError ? mutation.variables : undefined

      if (failed === undefined || !fields.some((field) => field in failed)) return undefined

      return `Не вдалося зберегти налаштування. ${describeError(mutation.error)}`.trim()
    },
  }
}
