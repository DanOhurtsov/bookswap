'use client'

import type { ReactNode } from 'react'
import { Toast } from '@base-ui/react/toast'
import { CircleCheck } from 'lucide-react'

/**
 * App-wide toasts (Base UI Toast). Mounted once in the root layout, above the routes, so a toast
 * added just before navigating stays on screen on the next page. Every toast is announced politely
 * through the viewport's live region.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed inset-x-4 bottom-6 z-50 mx-auto flex w-auto max-w-sm flex-col items-center gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()

  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      data-slot="toast"
      className="flex items-center gap-2.5 rounded-xl bg-(--fg) px-4 py-3 text-sm font-semibold text-(--bg) shadow-[0_8px_24px_rgba(20,28,24,.24)] transition-[opacity,transform] duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
    >
      <CircleCheck aria-hidden="true" className="size-[18px] shrink-0" />
      <Toast.Title className="m-0 text-sm font-semibold" />
    </Toast.Root>
  ))
}

export const useToastManager = Toast.useToastManager
