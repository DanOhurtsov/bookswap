'use client'

import type { AuthorMatch } from '@bookswap/shared'
import { useState } from 'react'
import { useWatch, type Control, type FieldErrors } from 'react-hook-form'
import { authorDisplayRows, type AuthorName } from '../model/field-display'
import type { InlineEditors } from '../model/use-inline-editors'
import type { WorkCorrectionFormValues } from '../model/work-form'
import { AuthorListEditor } from './AuthorListEditor'
import { InlineField } from './InlineField'

type AuthorsFieldProps = {
  control: Control<WorkCorrectionFormValues>
  errors: FieldErrors<WorkCorrectionFormValues>
  editors: InlineEditors<'authors'>
  /** The Work's own authors by id — `authorLookup()`. */
  knownAuthors: ReadonlyMap<string, AuthorName>
}

/**
 * The author list as ONE inline field (BS-76): the whole list is confirmed or
 * cancelled at once. Names of candidates picked from search live here — not
 * in the form value, which stays the strict PATCH shape (`authorId` only), and
 * not in a row, which unmounts whenever the editor closes.
 */
export function AuthorsField({ control, errors, editors, knownAuthors }: AuthorsFieldProps) {
  const [picked, setPicked] = useState<ReadonlyMap<string, AuthorName>>(() => new Map())
  const authors = useWatch({ control, name: 'authors' })
  // The Work's own authors win: they are what the server says right now.
  const names = new Map([...picked, ...knownAuthors])
  const rows = authorDisplayRows(authors, names)

  return (
    <InlineField
      name="authors"
      label="Автори"
      addLabel="Додати автора"
      display={
        rows.length === 0 ? null : (
          <ol className="inline-field__list">
            {rows.map((row) => (
              <li key={row.key}>
                {row.name}
                {row.nameLatin !== null && ` (${row.nameLatin})`} — {row.role}
              </li>
            ))}
          </ol>
        )
      }
      editors={editors}
    >
      <AuthorListEditor
        control={control}
        errors={errors}
        names={names}
        onPick={(candidate: AuthorMatch) => {
          setPicked((current) =>
            new Map(current).set(candidate.id, {
              name: candidate.name,
              nameLatin: candidate.nameLatin,
            }),
          )
        }}
      />
    </InlineField>
  )
}
