'use client'

import { useId } from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'

import { cn } from '@/lib/utils'

type SwitchRowProps = Omit<SwitchPrimitive.Root.Props, 'render' | 'nativeButton' | 'children'> & {
  label: string
  description?: string
}

/**
 * A settings row that is one switch: the label and its hint on the left, the track on the right. The
 * whole row is the control (`role="switch"`, at least 60 px tall), so it is easy to hit with a finger.
 * Its accessible name is the label alone; the hint is its description.
 */
function SwitchRow({ label, description, className, ...props }: SwitchRowProps) {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <SwitchPrimitive.Root
      data-slot="switch-row"
      nativeButton
      // `data-ui` opts the row out of the global `button` look (globals.css), as `Button` does.
      render={<button type="button" data-ui="button" />}
      aria-labelledby={labelId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      className={cn(
        'group/switch flex min-h-[60px] w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent py-2.5 text-left text-inherit [font:inherit] outline-none focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bookswap-accent) data-disabled:cursor-not-allowed data-disabled:opacity-60',
        className,
      )}
      {...props}
    >
      <span className="flex flex-col gap-0.5">
        <span id={labelId} className="text-[15px] leading-[21px] font-medium">
          {label}
        </span>
        {description !== undefined && (
          <span id={descriptionId} className="text-[13px] leading-[18px] text-(--bookswap-muted)">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="relative h-[26px] w-11 shrink-0 rounded-full bg-(--line) transition-colors group-data-checked/switch:bg-(--bookswap-accent)"
      >
        <SwitchPrimitive.Thumb className="absolute top-[3px] left-[3px] size-5 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-[18px]" />
      </span>
    </SwitchPrimitive.Root>
  )
}

export { SwitchRow }
