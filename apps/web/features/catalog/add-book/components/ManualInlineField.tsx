'use client'

import { CheckIcon, PencilIcon, XIcon } from 'lucide-react'
import { useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { TextField } from '@/components/Form/FormFields'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ManualSection } from '../model/manual-field-view'
import type { ManualFieldName } from '../model/manual-form'
import type { ManualDraft, ManualEditors } from '../model/use-manual-draft'

/**
 * «Додати …»: a text action that looks like the app's links (underline on hover or focus) but stays a
 * button — it opens an editor or a row, it goes nowhere. The label's colour at the value's size, so
 * it reads as "nothing here yet" rather than as a value. `my-2.5` gives its row the icon buttons'
 * 2.75rem height, and `after:` stretches the hit area over it without moving the underline.
 */
export const MANUAL_ADD_ACTION =
  'link-underline relative my-2.5 cursor-pointer justify-self-start rounded-sm text-left text-(--bookswap-muted) after:absolute after:inset-x-0 after:-inset-y-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bookswap-accent)'

type ManualInlineFieldProps = {
  name: ManualFieldName
  label: string
  /** The draft value as text, a list as several lines; `null` — nothing known, the field offers `addLabel`. */
  display: string | readonly string[] | null
  editors: ManualEditors
  /** The action an empty field shows in place of its value, e.g. «Додати ISBN». */
  addLabel: string
  /** The editor's control(s), bound to the draft. */
  children: ReactNode
  /** One more action of this field, beside its own in both modes — the ISBN scanner. */
  aside?: ReactNode
}

/**
 * One field of the manual form as text, with its editor in place (BS-76). A thin switch: which
 * editor is open lives in `useManualDraft`, which outlives any single field's two modes.
 */
export function ManualInlineField({
  name,
  label,
  display,
  editors,
  addLabel,
  children,
  aside,
}: ManualInlineFieldProps) {
  const labelId = useId()

  if (editors.isOpen(name)) {
    return (
      <ManualFieldEditor name={name} label={label} editors={editors} aside={aside}>
        {children}
      </ManualFieldEditor>
    )
  }

  const trigger = {
    type: 'button' as const,
    ref: (element: HTMLButtonElement | null) => {
      editors.registerTrigger(name, element)
    },
    onClick: () => {
      editors.open(name)
    },
  }

  return (
    // A named group ties the value to its field name for assistive technology, as a label would.
    // Two rows: the label alone, then the value with its action — the pencil is centred on the
    // value, where the text sits inside the input once the editor opens, not on label + value.
    // An `aside` takes a third column on the value's row.
    <div
      className={cn(
        'group/field grid items-center gap-x-3 border-b border-(--line) pb-2',
        aside === undefined
          ? 'grid-cols-[minmax(0,1fr)_auto]'
          : 'grid-cols-[minmax(0,1fr)_auto_auto]',
      )}
      role="group"
      aria-labelledby={labelId}
    >
      <span className="inline-field__label col-span-full" id={labelId}>
        {label}
      </span>
      {display === null ? (
        // It spans the pencil's column too, so an `aside` stays in the last one.
        <Button {...trigger} variant="unstyled" className={cn(MANUAL_ADD_ACTION, 'col-span-2')}>
          {addLabel}
        </Button>
      ) : (
        <>
          {typeof display === 'string' ? (
            <p className="inline-field__value m-0">{display}</p>
          ) : (
            // One name per line, in the draft's order — no markers, so no indent either. The value's
            // own wrapping too: a name with no spaces breaks inside its column, not under the pencil.
            <ol className="inline-field__value m-0 list-none p-0">
              {display.map((line, index) => (
                <li key={`${String(index)}:${line}`}>{line}</li>
              ))}
            </ol>
          )}
          <Button
            {...trigger}
            variant="ghost"
            size="icon"
            // Only where hover is real: hidden until the row is hovered or holds focus. `opacity`,
            // not `display`, so the button stays in the Tab order; without hover it is always shown.
            className="size-11 cursor-pointer [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/field:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/field:opacity-100"
            aria-label={`Редагувати: ${label}`}
          >
            <PencilIcon aria-hidden="true" className="size-[1.1rem]" />
          </Button>
        </>
      )}
      {aside}
    </div>
  )
}

type ManualFieldEditorProps = Pick<
  ManualInlineFieldProps,
  'name' | 'label' | 'editors' | 'children' | 'aside'
>

/**
 * The editor restyles the form's usual fields (`TextField`, `LanguageSelect`, …) to sit where the
 * value was: the label as in the view, the control at the value's size with no box, border, outline
 * or ring, hint and error under it. `!` because the global `.field` rules are unlayered and would
 * otherwise beat any utility.
 */
const EDITOR_FIELDS =
  '[&_.field]:gap-0! [&_.field>p]:order-1 [&_[role=alert]]:order-2 ' +
  '[&_.field>label:not(.field--checkbox)]:text-[0.85rem]! [&_.field>label:not(.field--checkbox)]:font-normal! [&_.field>label:not(.field--checkbox)]:text-(--bookswap-muted) [&_legend]:text-[0.85rem] [&_legend]:text-(--bookswap-muted) [&_.field>label.field--checkbox]:font-normal! ' +
  '[&_:is(input:not([type=radio]),select)]:h-11! [&_:is(input:not([type=radio]),select)]:rounded-none! [&_:is(input:not([type=radio]),select)]:border-0! [&_:is(input:not([type=radio]),select)]:bg-transparent! [&_:is(input:not([type=radio]),select)]:p-0! [&_:is(input:not([type=radio]),select)]:outline-none! ' +
  // A select is as wide as its options, like a value with a dropdown, not a full-width box.
  '[&_select]:w-auto! [&_select]:max-w-full [&_select]:justify-self-start ' +
  // Chrome paints the open list with the select's own background: a transparent one leaves it white,
  // and in the dark theme the light option text vanishes on it. The options carry the theme's colours.
  '[&_:is(option,optgroup)]:bg-(--field-bg) [&_:is(option,optgroup)]:text-(--fg)'

/**
 * The field's own grid (`div.field`) dissolves into the editor's: the label on a row of its own,
 * then the control with the `aside` and ✓/✕ beside it — where the value, the scanner and the pencil
 * sit in the view — then hint and error across the full width. A fieldset (the radios) stays whole.
 */
const EDITOR_GRID =
  '[&_div.field]:contents! [&_.field>label]:col-span-full [&_.field>p]:col-span-full [&_[role=alert]]:col-span-full'

function ManualFieldEditor({ name, label, editors, children, aside }: ManualFieldEditorProps) {
  // Enter in a single-line input would otherwise submit the whole form — a new book the person
  // never asked for. Here it confirms just this field.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return

    event.preventDefault()
    editors.confirm(name)
  }

  return (
    <div
      className={cn(
        'grid items-center gap-x-3 border-b border-(--line) pb-2',
        aside === undefined
          ? 'grid-cols-[minmax(0,1fr)_auto]'
          : 'grid-cols-[minmax(0,1fr)_auto_auto]',
        EDITOR_FIELDS,
        EDITOR_GRID,
      )}
      ref={(element) => {
        editors.registerEditor(name, element)
      }}
      onKeyDown={handleKeyDown}
    >
      {children}
      {/* In the DOM before the actions, so Tab reaches it right after the control beside it. */}
      {aside}
      {/* Placed explicitly on the control's row (the second; beside a fieldset — its first), in the
          last column; the field's other parts flow around it. */}
      <div className="col-[-2/-1] row-start-2 flex [:has(>fieldset)>&]:row-start-1 [:has(>fieldset)>&]:self-start">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 cursor-pointer"
          aria-label={`Зберегти: ${label}`}
          title="Зберегти"
          onClick={() => {
            editors.confirm(name)
          }}
        >
          <CheckIcon aria-hidden="true" className="size-[1.1rem]" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 cursor-pointer"
          aria-label={`Скасувати: ${label}`}
          title="Скасувати"
          onClick={() => {
            editors.cancel(name)
          }}
        >
          <XIcon aria-hidden="true" className="size-[1.1rem]" />
        </Button>
      </div>
    </div>
  )
}

/** The fields whose value is free text typed into one input. */
type ManualTextFieldName =
  'title' | 'isbn' | 'translator' | 'publisher' | 'year' | 'pageCount' | 'coverUrl' | 'firstPubYear'

type ManualTextInlineFieldProps = {
  draft: ManualDraft
  name: ManualTextFieldName
  id: string
  label: string
  display: string | null
  addLabel: string
  hint?: string
  aside?: ReactNode
} & Pick<InputHTMLAttributes<HTMLInputElement>, 'inputMode' | 'type' | 'autoComplete' | 'required'>

/** A free-text field: its text view and, in the editor, the form's usual `TextField`. */
export function ManualTextInlineField({
  draft,
  name,
  id,
  label,
  display,
  addLabel,
  hint,
  aside,
  ...input
}: ManualTextInlineFieldProps) {
  const error = draft.errors[name]

  return (
    <ManualInlineField
      name={name}
      label={label}
      display={display}
      addLabel={addLabel}
      editors={draft}
      aside={aside}
    >
      <TextField
        {...input}
        id={id}
        label={label}
        value={draft.values[name]}
        {...(hint === undefined ? {} : { hint })}
        {...(error === undefined ? {} : { error })}
        onChange={(event) => {
          draft.change(name, event.target.value)
        }}
      />
    </ManualInlineField>
  )
}

type ManualSectionDetailsProps = {
  draft: ManualDraft
  section: ManualSection
  summary: string
  children: ReactNode
}

/**
 * A collapsible part of the form. Open or closed is the draft's state, not the DOM's: a failed
 * «Додати до бібліотеки» must be able to open it around an invalid field.
 */
export function ManualSectionDetails({
  draft,
  section,
  summary,
  children,
}: ManualSectionDetailsProps) {
  return (
    <details
      open={draft.isSectionOpen(section)}
      onToggle={(event) => {
        draft.setSectionOpen(section, event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer">{summary}</summary>
      <div className="mt-4 grid gap-4">{children}</div>
    </details>
  )
}
