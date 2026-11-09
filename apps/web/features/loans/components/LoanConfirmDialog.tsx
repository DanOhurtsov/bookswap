'use client'

import { useEffect, useId, useRef, type RefObject } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { FormStatus } from '@/components/Form/FormStatus'
import { Button } from '@/components/ui/button'
import type { LoanPageActions } from '../model/use-loan-page-actions'

type LoanConfirmDialogProps = {
  actions: LoanPageActions
  /** Takes the focus when the dialog closes and what opened it is gone (the action changed the loan). */
  fallbackFocus: RefObject<HTMLElement | null>
}

/**
 * The canvas's confirmation of a dangerous action: a centred card, a sheet from the bottom on a phone.
 *
 * A native `<dialog>` with `showModal()`, as the shared `ConfirmDialog`: the browser traps the focus,
 * makes the page inert and handles Esc. Unlike it, a failure stays inside the dialog — the page under
 * it is inert, so the panel's alert would be neither seen nor heard — and the dialog stays open for
 * another try. On close the focus goes back to what opened it (the «⋯» button, not its menu item).
 *
 * While the action runs both buttons stay focusable (`focusableWhenDisabled`): a natively disabled
 * button drops the focus out of the dialog, and a failure would leave it nowhere. They are blocked by
 * `isPending` in their handlers, not by the attribute.
 */
export function LoanConfirmDialog({ actions, fallbackFocus }: LoanConfirmDialogProps) {
  const { confirmation, busyKey, failure, setConfirmation } = actions
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const isOpen = confirmation !== undefined
  const isPending = busyKey !== undefined

  useEffect(() => {
    const element = dialog.current

    if (element === null) return

    if (confirmation !== undefined && !element.open) {
      const focused = document.activeElement
      opener.current = confirmation.opener ?? (focused instanceof HTMLElement ? focused : null)
      element.showModal()
    }

    if (!isOpen && element.open) {
      element.close()
      const target = opener.current?.isConnected === true ? opener.current : fallbackFocus.current
      target?.focus()
    }
  }, [isOpen, confirmation, fallbackFocus])

  const close = () => {
    if (!isPending) setConfirmation(undefined)
  }

  return (
    <dialog
      ref={dialog}
      className="loan-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        // Esc: the parent owns `open`, so the browser's own close is held back.
        event.preventDefault()
        close()
      }}
    >
      <h2 id={titleId} className="loan-dialog__title">
        {confirmation?.title}
      </h2>
      <p id={descriptionId} className="loan-dialog__text">
        {confirmation?.description}
      </p>
      {isOpen && <FormStatus error={failure} />}
      <div className="loan-dialog__actions">
        <Button
          type="button"
          variant="outline"
          className="loan-action"
          disabled={isPending}
          focusableWhenDisabled
          onClick={close}
        >
          {confirmation?.dismissLabel ?? 'Назад'}
        </Button>
        <Button
          type="button"
          variant="unstyled"
          className="loan-action loan-action--danger"
          disabled={isPending}
          focusableWhenDisabled
          aria-busy={isPending}
          onClick={() => {
            // `focusableWhenDisabled` only marks the button: the guard is what blocks a repeat.
            if (isPending) return
            void confirmation?.run()
          }}
        >
          {isPending && (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          )}
          {isPending ? 'Виконую…' : confirmation?.confirmLabel}
        </Button>
      </div>
    </dialog>
  )
}
