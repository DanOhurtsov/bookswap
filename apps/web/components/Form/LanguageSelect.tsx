'use client'

import { LANGUAGE_CODES } from '@bookswap/shared'
import { LANGUAGE_HINTS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import { SelectField } from './FormFields'

type LanguageSelectProps = {
  id: string
  label: string
  hint?: string
  value: string
  error?: string
  /** Порожнє значення ('') — «невідомо / не вказано»; без `emptyLabel` вибір обов'язковий. */
  emptyLabel?: string
  onChange: (value: string) => void
}

const POPULAR = new Set(LANGUAGE_HINTS.map((language) => language.code))

/** Назви мов українською, відсортовані за алфавітом: код ISO 639-1 людині нічого не каже. */
const OTHER = [...LANGUAGE_CODES]
  .filter((code) => !POPULAR.has(code))
  .map((code) => ({ code, label: languageName(code) }))
  .sort((one, other) => one.label.localeCompare(other.label, 'uk'))

/**
 * Вибір мови за назвою, а не за кодом (docs/plan/fast-book-add.md, §2.1). Поширені мови — окремою групою
 * нагорі. Значення — код ISO 639-1; невідому мову можна лишити невказаною, не вигадуючи її.
 */
export function LanguageSelect({
  id,
  label,
  hint,
  value,
  error,
  emptyLabel,
  onChange,
}: LanguageSelectProps) {
  return (
    <SelectField
      id={id}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      <optgroup label="Поширені">
        {LANGUAGE_HINTS.map((language) => (
          <option key={language.code} value={language.code}>
            {languageName(language.code)}
          </option>
        ))}
      </optgroup>
      <optgroup label="Усі мови">
        {OTHER.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </optgroup>
    </SelectField>
  )
}
