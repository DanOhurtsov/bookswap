'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  CONDITION,
  VISIBILITY,
  addCopyRequestSchema,
  copyResponseSchema,
  type AddCopyRequest,
  type CopyEntryMethod,
} from '@bookswap/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useForm, type FieldErrors, type UseFormRegister } from 'react-hook-form'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { CONDITION_LABELS, VISIBILITY_LABELS } from '@/app/lib/labels'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { invalidateActivation } from '@/features/library/activation/index.client'
import { nullableText } from '../model/form-values'
import { DEFAULT_COPY_DEFAULTS, type CopyDefaults } from '../model/copy-defaults'

type CopyStepProps = {
  editionId: string
  defaults?: CopyDefaults
  entryMethod?: CopyEntryMethod
  onDone: (defaults: CopyDefaults) => void
}

type CopyFieldsProps = {
  errors: FieldErrors<AddCopyRequest>
  register: UseFormRegister<AddCopyRequest>
}

function defaultValues(
  editionId: string,
  defaults: CopyDefaults,
  entryMethod: CopyEntryMethod,
): AddCopyRequest {
  return {
    editionId,
    condition: defaults.condition,
    visibility: defaults.visibility,
    note: null,
    acquiredAt: null,
    entryMethod,
  }
}

function CopyFields({ errors, register }: CopyFieldsProps) {
  return (
    <>
      <SelectField id="copy-condition" label="Стан примірника" {...register('condition')}>
        {CONDITION.map((value) => (
          <option key={value} value={value}>
            {CONDITION_LABELS[value]}
          </option>
        ))}
      </SelectField>
      <SelectField id="copy-visibility" label="Кому показувати" {...register('visibility')}>
        {VISIBILITY.map((value) => (
          <option key={value} value={value}>
            {VISIBILITY_LABELS[value]}
          </option>
        ))}
      </SelectField>
      <TextField
        id="copy-note"
        label="Нотатка"
        hint="Видно лише вам."
        error={errors.note?.message}
        {...register('note', { setValueAs: nullableText })}
      />
      <TextField
        id="copy-acquired"
        label="Коли зʼявилася"
        type="date"
        error={errors.acquiredAt?.message}
        {...register('acquiredAt', { setValueAs: nullableText })}
      />
    </>
  )
}

export function CopyStep({
  editionId,
  defaults = DEFAULT_COPY_DEFAULTS,
  entryMethod = 'MANUAL',
  onDone,
}: CopyStepProps) {
  const [failure, setFailure] = useState<unknown>()
  const isSubmissionLocked = useRef(false)
  const queryClient = useQueryClient()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AddCopyRequest>({
    resolver: zodResolver(addCopyRequestSchema),
    defaultValues: defaultValues(editionId, defaults, entryMethod),
  })

  async function submit(request: AddCopyRequest): Promise<void> {
    if (isSubmissionLocked.current) return

    isSubmissionLocked.current = true
    setFailure(undefined)

    try {
      await apiRequest('/me/library', {
        method: 'POST',
        body: request,
        schema: copyResponseSchema,
      })
      // Stage 8h-2: the one place a Copy is born in this wizard — the first
      // book and every «ще один такий примірник» both land here — so this is
      // the one place the checklist needs to be told. After the POST resolved:
      // a rejected request throws above and invalidates nothing.
      await invalidateActivation(queryClient)
      onDone({
        condition: request.condition ?? DEFAULT_COPY_DEFAULTS.condition,
        visibility: request.visibility ?? DEFAULT_COPY_DEFAULTS.visibility,
      })
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      isSubmissionLocked.current = false
    }
  }

  return (
    <form className="form" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
      <FormStatus error={failure} />
      <input type="hidden" {...register('entryMethod')} />
      <CopyFields errors={errors} register={register} />
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Додаю…' : 'Додати до бібліотеки'}
      </button>
    </form>
  )
}
