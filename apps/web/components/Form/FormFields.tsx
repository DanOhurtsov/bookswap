'use client'

import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface FieldShellProps {
  id: string
  label: string
  error?: string
  hint?: string
  /** The label beside the control, in the muted inline style of filters and the page size. */
  inline?: boolean
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode
}

/**
 * A form field's accessible markup.
 *
 * Three things that usually get lost and without which a form is unusable with a screen reader:
 * `<label for>`, `aria-invalid` and `aria-describedby` pointing at the error text. So they live in
 * one place instead of being repeated in every form.
 */
function FieldShell({ id, label, error, hint, inline = false, children }: FieldShellProps) {
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ')

  return (
    <div className={inline ? 'search-pagination__size' : 'field'}>
      <label htmlFor={id}>{label}</label>
      {hint !== undefined && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {children({
        id,
        describedBy: describedBy === '' ? undefined : describedBy,
        invalid: error !== undefined,
      })}
      {error !== undefined && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// Text Field
type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  id: string
  label: string
  error?: string
  hint?: string
}

function TextField({ id, label, error, hint, ...input }: TextFieldProps) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      {({ describedBy, invalid }) => (
        <input
          {...input}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  )
}

// Text Area Field
type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
  id: string
  label: string
  error?: string
  hint?: string
}

function TextAreaField({ id, label, error, hint, ...textarea }: TextAreaFieldProps) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      {({ describedBy, invalid }) => (
        <textarea
          {...textarea}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </FieldShell>
  )
}

// Select Field
/** One choice of a select or combobox field: what is sent, and what the person reads. */
type FieldOption<TValue extends string> = { value: TValue; label: string }

/** What `SelectField` and `ComboboxField` share: the value, its options' callback and the form hooks. */
type ChoiceFieldProps<TValue extends string> = {
  id: string
  label: string
  error?: string
  hint?: string
  /**
   * `''` that no option carries means nothing is chosen yet: the trigger shows `placeholder`. A field
   * that may be emptied has an option with the value `''` («будь-який», «Не вказано»).
   */
  value: TValue | ''
  /** Called only with an option's value — never with a placeholder or a search text. */
  onValueChange: (value: TValue) => void
  placeholder?: string
  disabled?: boolean
  /** See `FieldShell`: for filters beside a list, not for form fields. */
  inline?: boolean
  onBlur?: () => void
  /** For react-hook-form's `field.ref`: focusing it moves focus to the trigger. */
  inputRef?: Ref<HTMLInputElement>
}

type SelectFieldProps<TValue extends string> = ChoiceFieldProps<TValue> & {
  options: readonly FieldOption<TValue>[]
}

/** A short fixed list. Long or searchable lists use `ComboboxField`. */
function SelectField<TValue extends string>({
  id,
  label,
  error,
  hint,
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  inline,
  onBlur,
  inputRef,
}: SelectFieldProps<TValue>) {
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} inline={inline}>
      {({ describedBy, invalid }) => (
        <Select
          value={options.find((option) => option.value === value) ?? null}
          isItemEqualToValue={sameOption}
          onValueChange={(option) => {
            if (option !== null) onValueChange(option.value)
          }}
          {...(disabled === undefined ? {} : { disabled })}
          {...(inputRef === undefined ? {} : { inputRef })}
        >
          <SelectTrigger
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onBlur={onBlur}
          >
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldShell>
  )
}

/** A fixed list's options in the domain's order, each named by its label. */
function labelledOptions<TValue extends string>(
  values: readonly TValue[],
  labels: Readonly<Record<TValue, string>>,
): FieldOption<TValue>[] {
  return values.map((value) => ({ value, label: labels[value] }))
}

/** Options are compared by value, never by object identity: callers rebuild them every render. */
function sameOption<TValue extends string>(
  one: FieldOption<TValue>,
  other: FieldOption<TValue>,
): boolean {
  return one.value === other.value
}

export { FieldShell, TextField, TextAreaField, SelectField, labelledOptions, sameOption }
export type { ChoiceFieldProps, FieldOption }
