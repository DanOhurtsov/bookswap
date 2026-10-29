'use client'

import type { ReactElement } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

/**
 * A short label beside a control that shows only an icon, on hover and on keyboard focus (Base UI
 * Tooltip). It is never the control's only name: the control keeps its own `aria-label`, and the
 * tooltip repeats it for the eyes. A touch screen has no hover, so nothing may live only in here.
 */
function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={300} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="bottom" sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            className="rounded-md bg-(--fg) px-2.5 py-1.5 text-[13px] leading-[18px] font-medium text-(--bg) shadow-[0_4px_12px_rgba(20,28,24,.2)] transition-[opacity,transform] duration-150 data-ending-style:opacity-0 data-starting-style:-translate-y-0.5 data-starting-style:opacity-0"
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip }
