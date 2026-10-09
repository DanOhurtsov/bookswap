'use client'

import type { ComponentProps } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit max-w-full items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-muted group-data-horizontal/tabs:h-8',
        // Line tabs wrap instead of overflowing a narrow screen. The row gap leaves room for the
        // active underline, which sits below the trigger box.
        line: 'flex-wrap justify-start gap-x-1 gap-y-2 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function TabsList({
  className,
  variant = 'default',
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

// Shared by `TabsTrigger` and `ToggleTab`: both mark their selected state with `data-active`.
const tabsTriggerClassName = cn(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  // Line tabs size to their label: a wrapped row must not stretch them, or the underline would span
  // the row, and a percentage height has nothing definite to resolve against in a wrapping list.
  'group-data-[variant=line]/tabs-list:h-auto group-data-[variant=line]/tabs-list:flex-none group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent',
  'data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground',
  'after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
)

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      // Opt out of the global `button:not([data-ui='button'])` rule in globals.css.
      data-ui="button"
      className={cn(tabsTriggerClassName, className)}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      // The open panel is a tab stop (Base UI sets tabIndex=0), so its focus must stay visible.
      className={cn(
        'flex-1 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Line-tab look for a row of toggle buttons. For switchers that are filters rather than tabs:
 * there are no panels, each button keeps `aria-pressed` and its own Tab stop.
 */
function ToggleTabs({ className, ...props }: ComponentProps<'div'>) {
  return (
    // The trigger styles read orientation and variant from these two group ancestors.
    <div data-slot="tabs" data-orientation="horizontal" className="group/tabs flex">
      <div
        role="group"
        data-slot="tabs-list"
        data-variant="line"
        className={cn(tabsListVariants({ variant: 'line' }), className)}
        {...props}
      />
    </div>
  )
}

type ToggleTabProps = Omit<ComponentProps<'button'>, 'aria-pressed'> & { pressed: boolean }

function ToggleTab({ pressed, className, ...props }: ToggleTabProps) {
  return (
    <button
      type="button"
      data-slot="tabs-trigger"
      data-ui="button"
      aria-pressed={pressed}
      data-active={pressed ? '' : undefined}
      className={cn(tabsTriggerClassName, className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, ToggleTabs, ToggleTab, tabsListVariants }
