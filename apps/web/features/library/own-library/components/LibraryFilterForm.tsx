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
 * markup stay, so showing them again is flipping this constant — and giving them a place in
 * `SEARCH_LAYOUT`, which lays out one text field and its button.
 */
const SHOW_STATUS_AND_LANG_FILTERS = false

/** `''` — any availability. */
const STATUS_OPTIONS = [
  { value: '', label: 'будь-яка' },
  ...labelledOptions(COPY_STATUS, COPY_STATUS_LABELS),
]

/**
 * The field and the button side by side, with the button on the input's row rather than at the
 * bottom of the whole field: a grid whose field spans its rows on a subgrid — label, input and, only
 * while there is one, the error (`role=alert`; an empty third row would add a gap under the field) —
 * so an error appears under the input in a row of its own and never moves the button. The grid's row
 * gap is the field's own gap: a different one would be made up with margins around the input, off
 * centre whenever the error row is absent, and the input would no longer fill its row. The input takes
 * the free column; the button keeps its content width. In a container narrower than `@xs` (20rem —
 * rem-based, so a larger root font stacks them too) the button goes under the field, still at its
 * content width. Local to this form: `.search` is not used here, so other search forms are untouched.
 */
const SEARCH_LAYOUT = [
  'mb-4 flex flex-col items-start gap-3 [&>.field]:self-stretch',
  '@xs:grid @xs:grid-cols-[minmax(0,1fr)_auto] @xs:gap-y-(--field-gap)',
  '@xs:[&>.field]:row-span-2 @xs:[&>.field:has(>[role=alert])]:row-span-3',
  '@xs:[&>.field]:grid-rows-subgrid',
].join(' ')

/**
 * The submit button takes the text field's vertical box, built from the same tokens as `.field input`
 * in `globals.css`: the field's block padding, the button's own 1px border (as the field's), and a
 * line box as tall as the field's inherited text — body line-height × 1rem, since `body` sets no font
 * size. So both are the same outer height at any root font size, also when it is stacked under the
 * field. Only the box changes: the text size, colors and focus ring stay the Button's. Side by side it
 * sits on the input's row of `SEARCH_LAYOUT`, centred on it like the input.
 */
const SUBMIT_CLASSES = [
  'h-auto py-(--field-padding-block) leading-[calc(var(--body-line-height)*1rem)]',
  '@xs:col-start-2 @xs:row-start-2 @xs:self-center',
].join(' ')

export function LibraryFilterForm({ filters }: LibraryFilterFormProps) {
  const { draft, errors } = filters

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    filters.apply()
  }

  return (
    // The whole block is capped, not just the button: on a wide page the field would otherwise
    // stretch across it. The cap is on the query container, so `@xs` measures the block itself.
    <div className="@container max-w-xl">
      <form className={SEARCH_LAYOUT} onSubmit={handleSubmit} noValidate>
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

        <Button type="submit" className={SUBMIT_CLASSES}>
          Пошук
        </Button>
      </form>
    </div>
  )
}
