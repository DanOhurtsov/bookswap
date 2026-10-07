'use client'

import { useState } from 'react'
import {
  updateCopyRequestSchema,
  type Condition,
  type OwnCopy,
  type UpdateCopyRequest,
  type Visibility,
} from '@bookswap/shared'
import { validate, type FieldErrors } from '@/app/lib/validation'

export interface CopyDraft {
  condition: Condition
  visibility: Visibility
  note: string
  acquiredAt: string
  setCondition: (value: Condition) => void
  setVisibility: (value: Visibility) => void
  setNote: (value: string) => void
  setAcquiredAt: (value: string) => void
  errors: FieldErrors
  /** The request body for a valid draft; for an invalid one nothing, and `errors` says why. */
  submit: () => UpdateCopyRequest | undefined
}

/**
 * The values of the copy edit form. They start from the copy as it was when the row appeared and
 * stay as typed until the row goes away, so closing the form does not discard them.
 */
export function useCopyDraft(copy: OwnCopy): CopyDraft {
  const [condition, setCondition] = useState<Condition>(copy.condition)
  const [visibility, setVisibility] = useState<Visibility>(copy.visibility)
  const [note, setNote] = useState(copy.note ?? '')
  const [acquiredAt, setAcquiredAt] = useState(copy.acquiredAt ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})

  function submit(): UpdateCopyRequest | undefined {
    const result = validate(updateCopyRequestSchema, {
      condition,
      visibility,
      note: note.trim() === '' ? null : note,
      acquiredAt: acquiredAt === '' ? null : acquiredAt,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return undefined
    }

    setErrors({})

    return result.data
  }

  return {
    condition,
    visibility,
    note,
    acquiredAt,
    setCondition,
    setVisibility,
    setNote,
    setAcquiredAt,
    errors,
    submit,
  }
}
