'use client'

import { useFieldArray, type Control, type FieldErrors } from 'react-hook-form'
import { AuthorFormRow } from './AuthorFormRow'
import { newAuthorFormValue } from '../model/author-list'
import type { WorkCorrectionFormValues } from '../model/work-form'

type AuthorListEditorProps = {
  control: Control<WorkCorrectionFormValues>
  errors: FieldErrors<WorkCorrectionFormValues>
  knownAuthors: ReadonlyMap<string, { name: string; nameLatin: string | null }>
}

/** R10a, minimal 8e-3 scope: add/remove/reorder (Up/Down, no drag-and-drop). */
export function AuthorListEditor({ control, errors, knownAuthors }: AuthorListEditorProps) {
  const { fields, append, remove, move } = useFieldArray({ control, name: 'authors' })

  return (
    <fieldset className="authors">
      <legend>Автори</legend>
      {errors.authors?.message !== undefined && (
        <p className="field__error" role="alert">
          {errors.authors.message}
        </p>
      )}
      {fields.map((field, index) => (
        <AuthorFormRow
          key={field.id}
          control={control}
          index={index}
          knownAuthors={knownAuthors}
          canRemove={fields.length > 1}
          onRemove={() => {
            remove(index)
          }}
          {...(index > 0 ? { onMoveUp: () => move(index, index - 1) } : {})}
          {...(index < fields.length - 1 ? { onMoveDown: () => move(index, index + 1) } : {})}
        />
      ))}
      <button
        type="button"
        className="button--ghost"
        onClick={() => {
          append(newAuthorFormValue())
        }}
      >
        Додати ще автора
      </button>
    </fieldset>
  )
}
