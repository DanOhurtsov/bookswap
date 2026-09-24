'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  createWorkRequestSchema,
  workDetailResponseSchema,
  type BookLookupResult,
  type CreateWorkRequest,
} from '@bookswap/shared'
import { useState } from 'react'
import {
  Controller,
  useFieldArray,
  useForm,
  type Control,
  type FieldErrors,
  type UseFormRegister,
} from 'react-hook-form'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { mapLookupResultToDraft } from '@/app/lib/lookup-mapping'
import { TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { AuthorRow } from './AuthorRow'
import { LanguageField } from './LanguageField'
import { nullableNumber, nullableText } from '../model/form-values'

type WorkStepProps = {
  initialTitle: string
  lookup?: BookLookupResult
  /** Work-level year from an external source; never an edition's printing year. */
  firstPubYear?: number
  onCreated: (workId: string, title: string) => void
}

type WorkFieldsProps = {
  control: Control<CreateWorkRequest>
  errors: FieldErrors<CreateWorkRequest>
  register: UseFormRegister<CreateWorkRequest>
}

function messageOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('message' in error && typeof error.message === 'string') return error.message
  if ('root' in error) return messageOf(error.root)
  return 'name' in error ? messageOf(error.name) : undefined
}

/**
 * `firstPubYear` is prefilled only from the work-level year passed in beside
 * the lookup draft. `mapLookupResultToDraft` deliberately never produces one:
 * its input describes an edition, and a reprint's year is not the year the work
 * first appeared. The field stays editable either way.
 */
function defaultValues(
  initialTitle: string,
  lookup: BookLookupResult | undefined,
  firstPubYear: number | undefined,
): CreateWorkRequest {
  const draft = mapLookupResultToDraft(lookup)
  const names = draft.work.authors.length === 0 ? [''] : draft.work.authors

  return {
    title: draft.work.title === '' ? initialTitle : draft.work.title,
    origLang: 'uk',
    firstPubYear: firstPubYear ?? null,
    description: draft.work.description === '' ? null : draft.work.description,
    authors: names.map((name) => ({ name, role: 'AUTHOR' })),
  }
}

function WorkFields({ control, errors, register }: WorkFieldsProps) {
  return (
    <>
      <TextField
        id="work-title"
        label="Назва твору"
        required
        error={errors.title?.message}
        {...register('title')}
      />
      <Controller
        control={control}
        name="origLang"
        render={({ field }) => (
          <LanguageField
            id="work-lang"
            label="Мова оригіналу"
            hint="Мова, якою твір написано, а не мова вашого примірника."
            value={field.value}
            error={errors.origLang?.message}
            onChange={field.onChange}
          />
        )}
      />
      <TextField
        id="work-year"
        label="Рік першого видання"
        type="number"
        inputMode="numeric"
        error={errors.firstPubYear?.message}
        {...register('firstPubYear', { setValueAs: nullableNumber })}
      />
      <TextAreaField
        id="work-description"
        label="Опис"
        rows={3}
        error={errors.description?.message}
        {...register('description', { setValueAs: nullableText })}
      />
    </>
  )
}

function AuthorsFieldset({ control, errors }: Omit<WorkFieldsProps, 'register'>) {
  const { fields, append, remove } = useFieldArray({ control, name: 'authors' })

  return (
    <fieldset className="authors">
      <legend>Автори</legend>
      {fields.map((field, index) => (
        <AuthorRow
          key={field.id}
          control={control}
          index={index}
          error={messageOf(errors.authors?.[index]) ?? messageOf(errors.authors)}
          {...(fields.length === 1 ? {} : { onRemove: () => remove(index) })}
        />
      ))}
      <button
        type="button"
        className="button--ghost"
        onClick={() => append({ name: '', role: 'AUTHOR' })}
      >
        Додати ще автора
      </button>
    </fieldset>
  )
}

export function WorkStep({ initialTitle, lookup, firstPubYear, onCreated }: WorkStepProps) {
  const [failure, setFailure] = useState<unknown>()
  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateWorkRequest>({
    resolver: zodResolver(createWorkRequestSchema),
    defaultValues: defaultValues(initialTitle, lookup, firstPubYear),
  })

  async function submit(request: CreateWorkRequest): Promise<void> {
    setFailure(undefined)

    try {
      const detail = await apiRequest('/works', {
        method: 'POST',
        body: request,
        schema: workDetailResponseSchema,
      })
      onCreated(detail.work.id, detail.work.title)
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    }
  }

  return (
    <form className="form" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
      <FormStatus error={failure} />
      {lookup !== undefined && (
        <div className="alert alert--ok" role="status">
          <p>Поля нижче підставлено з зовнішнього джерела — перевірте й виправте за потреби.</p>
        </div>
      )}
      <WorkFields control={control} errors={errors} register={register} />
      <AuthorsFieldset control={control} errors={errors} />
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Створюю…' : 'Далі: переклад'}
      </button>
    </form>
  )
}
