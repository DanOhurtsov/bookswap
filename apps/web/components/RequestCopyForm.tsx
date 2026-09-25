'use client'

import { useState } from 'react'
import { createLoanRequestSchema } from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { validate, type FieldErrors } from '@/app/lib/validation'

interface RequestCopyFormProps {
  copyId: string
  /** Some request is in flight — every button on the screen waits. */
  busy: boolean
  /** THIS copy's request is in flight. */
  submitting: boolean
  onSubmit: (body: Record<string, unknown>) => void
  onCancel: () => void
}

/** Message + proposed return date for a loan request; validation is the shared contract's. */
export function RequestCopyForm({
  copyId,
  busy,
  submitting,
  onSubmit,
  onCancel,
}: RequestCopyFormProps) {
  const [message, setMessage] = useState('')
  const [proposedDueAt, setProposedDueAt] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  function submit(): void {
    const result = validate(createLoanRequestSchema, {
      copyId,
      message: message.trim() === '' ? undefined : message,
      proposedDueAt: proposedDueAt === '' ? undefined : proposedDueAt,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    onSubmit({
      ...(result.data.message === undefined ? {} : { message: result.data.message }),
      ...(result.data.proposedDueAt === undefined
        ? {}
        : { proposedDueAt: result.data.proposedDueAt }),
    })
  }

  return (
    <div className="form">
      <TextField
        id={`message-${copyId}`}
        label="Повідомлення"
        hint="Побачить власник разом із запитом."
        autoComplete="off"
        value={message}
        error={errors.message}
        onChange={(event) => {
          setMessage(event.target.value)
        }}
      />

      <TextField
        id={`due-${copyId}`}
        label="Хочу повернути до"
        type="date"
        hint="Побажання: остаточний термін встановить власник."
        value={proposedDueAt}
        error={errors.proposedDueAt}
        onChange={(event) => {
          setProposedDueAt(event.target.value)
        }}
      />

      <div className="person__actions">
        <button type="button" disabled={busy} onClick={submit}>
          {submitting ? 'Надсилаю…' : 'Надіслати запит'}
        </button>
        <button type="button" className="button--ghost" disabled={busy} onClick={onCancel}>
          Скасувати
        </button>
      </div>
    </div>
  )
}
