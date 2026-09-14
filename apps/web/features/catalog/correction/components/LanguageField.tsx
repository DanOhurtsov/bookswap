'use client'

import { TextField } from '@/components/Form/FormFields'
import { LANGUAGE_HINTS } from '@/app/lib/labels'

// Same component as `features/catalog/add-book/components/LanguageField.tsx`
// — duplicated rather than imported (that feature only exposes
// `AddBookWizard` from its `index.client.ts`, §1.3).
type LanguageFieldProps = {
  id: string
  label: string
  hint?: string
  value: string
  error?: string
  onChange: (value: string) => void
}

export function LanguageField({ id, label, hint, value, error, onChange }: LanguageFieldProps) {
  return (
    <>
      <TextField
        id={id}
        label={label}
        hint={hint ?? 'Код ISO 639-1: uk, en, pl…'}
        list={`${id}-hints`}
        autoComplete="off"
        value={value}
        error={error}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
      <datalist id={`${id}-hints`}>
        {LANGUAGE_HINTS.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </datalist>
    </>
  )
}
