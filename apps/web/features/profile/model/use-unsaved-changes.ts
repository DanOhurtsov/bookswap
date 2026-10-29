'use client'

import { useEffect, useRef, useState } from 'react'

export interface UnsavedChanges {
  /** «Скасувати зміни?» is on screen. */
  confirming: boolean
  /** «Скасувати» and `Esc`: leave at once when nothing changed, otherwise ask first. */
  cancel: () => void
  /** «Продовжити редагування». */
  keepEditing: () => void
  /** «Скасувати зміни»: the draft is dropped. */
  discard: () => void
}

/**
 * BS-148: leaving the edit form never loses typing by accident. `Esc` is «Скасувати» (and, while the
 * question is open, «Продовжити редагування»); closing or reloading the tab with changes gets the
 * browser's own warning. While a save is in flight (`locked`) nothing here leaves: the answer decides.
 */
export function useUnsavedChanges({
  dirty,
  locked,
  leave,
}: {
  dirty: boolean
  locked: boolean
  leave: () => void
}): UnsavedChanges {
  const [confirming, setConfirming] = useState(false)

  const controller: UnsavedChanges = {
    confirming,
    cancel: () => {
      if (locked) return
      if (dirty) setConfirming(true)
      else leave()
    },
    keepEditing: () => {
      setConfirming(false)
    },
    discard: () => {
      if (locked) return
      setConfirming(false)
      leave()
    },
  }

  // The listener is added once; it reads the latest state through the ref.
  const latest = useRef(controller)

  useEffect(() => {
    latest.current = controller
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // A popup that closes on Escape (a select, a dialog) has already used it.
      if (event.key !== 'Escape' || event.defaultPrevented) return

      if (latest.current.confirming) latest.current.keepEditing()
      else latest.current.cancel()
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!dirty) return

    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [dirty])

  return controller
}
