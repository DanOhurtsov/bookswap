'use client'

import type { Ref } from 'react'
import { LANGUAGE_CODES } from '@bookswap/shared'
import { LANGUAGE_HINTS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import { ComboboxField } from './ComboboxField'
import type { FieldOption } from './FormFields'

type LanguageSelectProps = {
  id: string
  label: string
  hint?: string
  value: string
  error?: string
  /** The empty value ('') — «unknown / not set»; without `emptyLabel` a choice is required. */
  emptyLabel?: string
  /**
   * The languages offered — all of ISO 639-1 by default. A filter passes the codes its API accepts,
   * so the field never offers a value that would be refused.
   */
  codes?: readonly string[]
  /** See `FieldShell`. */
  inline?: boolean
  onChange: (value: string) => void
  onBlur?: () => void
  inputRef?: Ref<HTMLInputElement>
}

const POPULAR_CODES: readonly string[] = LANGUAGE_HINTS.map((language) => language.code)

function languageOption(code: string): FieldOption<string> {
  return { value: code, label: languageName(code) }
}

/** The common languages in their own order; the rest by their Ukrainian names, alphabetically. */
function languageGroups(codes: readonly string[]) {
  const offered = new Set(codes)
  const popular = POPULAR_CODES.filter((code) => offered.has(code)).map(languageOption)
  const other = codes
    .filter((code) => !POPULAR_CODES.includes(code))
    .map(languageOption)
    .sort((one, another) => one.label.localeCompare(another.label, 'uk'))

  return [
    ...(popular.length === 0 ? [] : [{ label: 'Поширені', options: popular }]),
    ...(other.length === 0 ? [] : [{ label: 'Усі мови', options: other }]),
  ]
}

const ALL_LANGUAGE_GROUPS = languageGroups(LANGUAGE_CODES)

/**
 * A language picked by its name, found by typing it, not by its code (docs/plan/fast-book-add.md,
 * §2.1; BS-92). The common languages come first as a group of their own. The value is the ISO 639-1
 * code; an unknown language can be left unset rather than invented.
 */
export function LanguageSelect({
  id,
  label,
  hint,
  value,
  error,
  emptyLabel,
  codes,
  inline,
  onChange,
  onBlur,
  inputRef,
}: LanguageSelectProps) {
  return (
    <ComboboxField
      id={id}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(inline === undefined ? {} : { inline })}
      {...(onBlur === undefined ? {} : { onBlur })}
      {...(inputRef === undefined ? {} : { inputRef })}
      value={value}
      options={emptyLabel === undefined ? [] : [{ value: '', label: emptyLabel }]}
      groups={codes === undefined ? ALL_LANGUAGE_GROUPS : languageGroups(codes)}
      placeholder="Оберіть мову"
      onValueChange={onChange}
    />
  )
}
