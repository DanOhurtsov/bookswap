'use client'

import { type FormEvent } from 'react'
import { COPY_STATUS } from '@bookswap/shared'
import { SelectField, TextField, labelledOptions } from '@/components/Form/FormFields'
import { LanguageSelect } from '@/components/Form/LanguageSelect'
import { Button } from '@/components/ui/button'
import { COPY_STATUS_LABELS } from '@/app/lib/labels'
import type { LibraryFilters } from '../model/use-library-filters'

type LibraryFilterFormProps = {
  filters: LibraryFilters
}

/**
 * The availability and language filters are hidden for now. Their state, the form handling and the
 * markup stay, so showing them again is flipping this constant.
 */
const SHOW_STATUS_AND_LANG_FILTERS = false

/** `''` — any availability. */
const STATUS_OPTIONS = [
  { value: '', label: 'будь-яка' },
  ...labelledOptions(COPY_STATUS, COPY_STATUS_LABELS),
]

export function LibraryFilterForm({ filters }: LibraryFilterFormProps) {
  const { draft, errors } = filters

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    filters.apply()
  }

  return (
    <form className="search" onSubmit={handleSubmit} noValidate>
      {SHOW_STATUS_AND_LANG_FILTERS && (
        <>
          <SelectField
            id="filter-status"
            label="Доступність"
            value={draft.status}
            options={STATUS_OPTIONS}
            onValueChange={filters.setStatus}
          />

          <LanguageSelect
            id="filter-lang"
            label="Мова"
            emptyLabel="будь-яка"
            value={draft.lang}
            {...(errors.lang === undefined ? {} : { error: errors.lang })}
            onChange={filters.setLang}
          />
        </>
      )}

      <TextField
        id="filter-q"
        label="Назва або автор"
        autoComplete="off"
        value={draft.query}
        error={errors.q}
        onChange={(event) => {
          filters.setQuery(event.target.value)
        }}
      />

      <Button type="submit">Застосувати</Button>
    </form>
  )
}
