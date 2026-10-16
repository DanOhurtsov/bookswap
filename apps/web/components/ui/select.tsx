'use client'

import { Select as SelectPrimitive } from '@base-ui/react/select'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// The shadcn `base-nova` select. The trigger's box (border, padding, background, focus ring,
// invalid border) is the form-control look in `globals.css`, shared with text inputs, so a select
// and an input side by side are the same height. `data-ui="button"` opts the trigger out of the
// global `button` styles.

const Select = SelectPrimitive.Root

/** Shared with `ComboboxTrigger`: the closed field looks the same whether it can search or not. */
const SELECT_TRIGGER_CLASS =
  "flex min-w-0 items-center justify-between gap-2 text-left font-normal select-none disabled:cursor-not-allowed disabled:opacity-60 data-disabled:cursor-not-allowed data-disabled:opacity-60 data-placeholder:text-(--bookswap-muted) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/** The value's text: a long one wraps inside the trigger instead of widening the page. */
const SELECT_VALUE_CLASS = 'min-w-0 flex-1 text-left break-words whitespace-normal'

/** Shared with `ComboboxContent`: one look for every open list. */
const SELECT_POPUP_CLASS =
  'relative isolate z-50 max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95'

/** Shared with `ComboboxItem`: rows tall enough to tap, long names wrap rather than clip. */
const SELECT_ITEM_CLASS =
  "relative flex w-full cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-base break-words whitespace-normal outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(SELECT_VALUE_CLASS, className)}
      {...props}
    />
  )
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-ui="button"
      className={cn(SELECT_TRIGGER_CLASS, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex text-(--bookswap-muted)">
        <ChevronDownIcon aria-hidden="true" className="pointer-events-none size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
  return (
    <SelectPrimitive.Portal>
      {/* Below the trigger like the combobox's list, not over it: the same place for every
          dropdown in the app. */}
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={false}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(SELECT_POPUP_CLASS, className)}
          {...props}
        >
          <SelectPrimitive.List className="max-h-[min(--spacing(80),var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(SELECT_ITEM_CLASS, className)}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon aria-hidden="true" className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SELECT_ITEM_CLASS,
  SELECT_POPUP_CLASS,
  SELECT_TRIGGER_CLASS,
  SELECT_VALUE_CLASS,
}
