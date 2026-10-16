'use client'

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox'
import { FieldShell, sameOption, type ChoiceFieldProps, type FieldOption } from './FormFields'
import { matchesSearch } from './option-search'

/** A headed part of the list, e.g. «Поширені». */
type ComboboxOptionGroup<TValue extends string> = {
  label: string
  options: readonly FieldOption<TValue>[]
}

type ComboboxFieldProps<TValue extends string> = ChoiceFieldProps<TValue> & {
  /** Shown first, without a heading — e.g. the empty choice «Не вказано». */
  options?: readonly FieldOption<TValue>[]
  groups?: readonly ComboboxOptionGroup<TValue>[]
}

/** Base UI's own group shape: a list of groups, each with its `items`. */
type ListGroup<TValue extends string> = {
  key: string
  label: string | undefined
  items: readonly FieldOption<TValue>[]
}

function listGroups<TValue extends string>(
  options: readonly FieldOption<TValue>[],
  groups: readonly ComboboxOptionGroup<TValue>[],
): ListGroup<TValue>[] {
  return [
    ...(options.length === 0 ? [] : [{ key: '', label: undefined, items: options }]),
    ...groups.map((group) => ({ key: group.label, label: group.label, items: group.options })),
  ]
}

/**
 * A long list with a search box (BS-92): closed it is a select showing the chosen option's name;
 * open, the search filters the options by their visible names. The search text is never the value —
 * only picking an option changes it, and closing without picking keeps the previous one.
 */
export function ComboboxField<TValue extends string>({
  id,
  label,
  error,
  hint,
  value,
  options = [],
  groups = [],
  onValueChange,
  placeholder,
  disabled,
  inline,
  onBlur,
  inputRef,
}: ComboboxFieldProps<TValue>) {
  const items = listGroups(options, groups)
  const selected =
    items.flatMap((group) => group.items).find((option) => option.value === value) ?? null

  return (
    <FieldShell id={id} label={label} error={error} hint={hint} inline={inline}>
      {({ describedBy, invalid }) => (
        <Combobox
          items={items}
          value={selected}
          isItemEqualToValue={sameOption}
          filter={(option: FieldOption<TValue>, query) => matchesSearch(option.label, query)}
          autoHighlight
          onValueChange={(option) => {
            if (option !== null) onValueChange(option.value)
          }}
          {...(disabled === undefined ? {} : { disabled })}
          {...(inputRef === undefined ? {} : { inputRef })}
        >
          <ComboboxTrigger
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onBlur={onBlur}
          >
            <ComboboxValue {...(placeholder === undefined ? {} : { placeholder })} />
          </ComboboxTrigger>
          <ComboboxContent aria-label={label}>
            <ComboboxInput placeholder="Пошук…" aria-label={`Пошук: ${label}`} />
            <ComboboxEmpty>Нічого не знайдено</ComboboxEmpty>
            <ComboboxList>
              {(group: ListGroup<TValue>) => (
                <ComboboxGroup key={group.key} items={group.items}>
                  {group.label !== undefined && <ComboboxLabel>{group.label}</ComboboxLabel>}
                  <ComboboxCollection>
                    {(option: FieldOption<TValue>) => (
                      <ComboboxItem key={option.value} value={option}>
                        {option.label}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )}
    </FieldShell>
  )
}
