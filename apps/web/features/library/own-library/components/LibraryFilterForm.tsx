'use client'

import { type FormEvent } from 'react'
import { COPY_STATUS } from '@bookswap/shared'
import { SelectField, TextField } from '@/components/Form/FormFields'
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
            onChange={(event) => {
              filters.setStatus(event.target.value)
            }}
          >
            <option value="">будь-яка</option>
            {COPY_STATUS.map((value) => (
              <option key={value} value={value}>
                {COPY_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <TextField
            id="filter-lang"
            label="Мова"
            autoComplete="off"
            placeholder="uk"
            value={draft.lang}
            error={errors.lang}
            onChange={(event) => {
              filters.setLang(event.target.value)
            }}
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
