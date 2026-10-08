'use client'

import { useState } from 'react'
import { libraryQueryRequestSchema, type LibraryQueryRequest } from '@bookswap/shared'
import { validate, type FieldErrors } from '@/app/lib/validation'
import { filtersKey } from './library-address'

interface LibraryFiltersOptions {
  /** What the address says is applied: the draft starts from it and follows it. */
  applied: LibraryQueryRequest
  /** A valid draft is applied by handing it back; the caller writes it to the address. */
  onApply: (filters: LibraryQueryRequest) => void
}

export interface LibraryFilters {
  /** What the shelf is read with: the filters of the address. */
  applied: LibraryQueryRequest
  /** The form values, as typed and not yet applied. `status` and `lang` back the fields that are hidden for now. */
  draft: { status: string; lang: string; query: string }
  setStatus: (value: string) => void
  setLang: (value: string) => void
  setQuery: (value: string) => void
  errors: FieldErrors
  /** Validates the draft; only a valid draft is handed to `onApply`. */
  apply: () => void
}

/** The own-shelf filter form: a draft the user edits, next to the applied filters the address holds. */
export function useLibraryFilters({ applied, onApply }: LibraryFiltersOptions): LibraryFilters {
  const [status, setStatus] = useState(applied.status ?? '')
  const [lang, setLang] = useState(applied.lang ?? '')
  const [query, setQuery] = useState(applied.q ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})

  // When the applied filters change under the form (back, forward, a link, or our own apply, which
  // trims what was typed), the draft is set to them. This is the one place the draft is set from
  // outside, so it is adjusted while rendering rather than in an effect, which would paint the old
  // draft for one frame.
  const key = filtersKey(applied)
  const [syncedKey, setSyncedKey] = useState(key)

  if (syncedKey !== key) {
    setSyncedKey(key)
    setStatus(applied.status ?? '')
    setLang(applied.lang ?? '')
    setQuery(applied.q ?? '')
    setErrors({})
  }

  function apply(): void {
    const result = validate(libraryQueryRequestSchema, {
      status: status === '' ? undefined : status,
      lang: lang.trim() === '' ? undefined : lang,
      q: query.trim() === '' ? undefined : query,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    onApply(result.data)
  }

  return {
    applied,
    draft: { status, lang, query },
    setStatus,
    setLang,
    setQuery,
    errors,
    apply,
  }
}
