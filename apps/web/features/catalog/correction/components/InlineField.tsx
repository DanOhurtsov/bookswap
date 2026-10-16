'use client'

import { PencilIcon } from 'lucide-react'
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import type { InlineEditors } from '../model/use-inline-editors'

type InlineFieldProps<TName extends string> = {
  name: TName
  label: string
  /** The draft value as text; `null` — the field is empty and offers «Додати». */
  display: ReactNode
  editors: InlineEditors<TName>
  /**
   * An error that can exist while the editor is closed — a server answer such
   * as a taken ISBN. Shown with the text view, never hidden behind it; the
   * open editor's control shows its own errors.
   */
  error?: string | undefined
  /** Replaces «Додати» for an empty field, e.g. «Додати автора». */
  addLabel?: string
  /** The editor's control(s), bound to the form field. */
  children: ReactNode
}

/** A thin switch between the two modes; which mode is current lives in `useInlineEditors`. */
export function InlineField<TName extends string>({
  name,
  label,
  display,
  editors,
  error,
  addLabel,
  children,
}: InlineFieldProps<TName>) {
  if (editors.isOpen(name)) {
    return (
      <InlineFieldEditor name={name} label={label} editors={editors}>
        {children}
      </InlineFieldEditor>
    )
  }

  return (
    <InlineFieldView
      name={name}
      label={label}
      display={display}
      editors={editors}
      error={error}
      addLabel={addLabel}
    />
  )
}

type InlineFieldViewProps<TName extends string> = Omit<InlineFieldProps<TName>, 'children'>

function InlineFieldView<TName extends string>({
  name,
  label,
  display,
  editors,
  error,
  addLabel,
}: InlineFieldViewProps<TName>) {
  const errorId = useId()
  const isEmpty = display === null
  const buttonProps = {
    type: 'button' as const,
    ref: (element: HTMLButtonElement | null) => {
      editors.registerTrigger(name, element)
    },
    'aria-describedby': error === undefined ? undefined : errorId,
    onClick: () => {
      editors.open(name)
    },
  }

  return (
    <div className="inline-field">
      <div className="inline-field__body">
        <span className="inline-field__label">{label}</span>
        {!isEmpty && <div className="inline-field__value">{display}</div>}
        {error !== undefined && (
          <p className="field__error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
      {isEmpty ? (
        <button
          {...buttonProps}
          className="button--ghost inline-field__add"
          // The visible word starts the accessible name (WCAG 2.5.3); the field name completes it.
          {...(addLabel === undefined ? { 'aria-label': `Додати: ${label}` } : {})}
        >
          {addLabel ?? 'Додати'}
        </button>
      ) : (
        <button {...buttonProps} className="inline-field__edit" aria-label={`Редагувати: ${label}`}>
          <PencilIcon aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

type InlineFieldEditorProps<TName extends string> = Pick<
  InlineFieldProps<TName>,
  'name' | 'label' | 'editors' | 'children'
>

function InlineFieldEditor<TName extends string>({
  name,
  label,
  editors,
  children,
}: InlineFieldEditorProps<TName>) {
  // Enter in a single-line input would otherwise submit the whole form — a
  // PATCH the person never asked for. Here it confirms just this field. A
  // combobox's search box is portalled out of this element, but React still
  // bubbles its keys here: there Enter picks an option and must not confirm.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
    if (!event.currentTarget.contains(event.target)) return

    event.preventDefault()
    void editors.confirm(name)
  }

  return (
    <div
      className="inline-field-editor"
      ref={(element) => {
        editors.registerEditor(name, element)
      }}
      onKeyDown={handleKeyDown}
    >
      {children}
      <div className="person__actions">
        <button
          type="button"
          aria-label={`Зберегти: ${label}`}
          onClick={() => void editors.confirm(name)}
        >
          Зберегти
        </button>
        <button
          type="button"
          className="button--ghost"
          aria-label={`Скасувати: ${label}`}
          onClick={() => {
            editors.cancel(name)
          }}
        >
          Скасувати
        </button>
      </div>
    </div>
  )
}

/** Placed right above the form's own «Зберегти» — the only action that sends anything. */
export function InlineSaveHint() {
  return (
    <p className="form__aside">
      Зміни полів потрапляють у каталог лише після загальної кнопки «Зберегти» нижче.
    </p>
  )
}
