'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  EDITION_FORMAT,
  createEditionRequestSchema,
  editionResponseSchema,
  type BookLookupResult,
  type CreateEditionRequest,
} from '@bookswap/shared'
import { useState } from 'react'
import { useForm, type FieldErrors, type UseFormRegister } from 'react-hook-form'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { mapLookupResultToDraft } from '@/app/lib/lookup-mapping'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { nullableNumber, nullableText } from '../model/form-values'

type EditionStepProps = {
  workId: string
  translationId: string | null
  lookup?: BookLookupResult
  initialIsbn?: string
  onCreated: (editionId: string) => void
}

type EditionFieldsProps = {
  errors: FieldErrors<CreateEditionRequest>
  register: UseFormRegister<CreateEditionRequest>
}

type EditionDefaultsInput = Pick<EditionStepProps, 'translationId' | 'lookup' | 'initialIsbn'>

function defaultValues({
  translationId,
  lookup,
  initialIsbn,
}: EditionDefaultsInput): CreateEditionRequest {
  const draft = mapLookupResultToDraft(lookup).edition

  return {
    translationId,
    publisher: draft.publisher === '' ? null : draft.publisher,
    year: draft.year === '' ? null : Number(draft.year),
    isbn13: initialIsbn ?? null,
    pageCount: draft.pageCount === '' ? null : Number(draft.pageCount),
    coverUrl: draft.coverUrl === '' ? null : draft.coverUrl,
    format: draft.format ?? 'PAPERBACK',
  }
}

function EditionFields({ errors, register }: EditionFieldsProps) {
  return (
    <>
      <TextField
        id="edition-publisher"
        label="Видавництво"
        error={errors.publisher?.message}
        {...register('publisher', { setValueAs: nullableText })}
      />
      <TextField
        id="edition-year"
        label="Рік видання"
        type="number"
        inputMode="numeric"
        error={errors.year?.message}
        {...register('year', { setValueAs: nullableNumber })}
      />
      <TextField
        id="edition-isbn"
        label="ISBN-13"
        inputMode="numeric"
        hint="Дефіси можна лишити. Контрольна сума перевіряється."
        error={errors.isbn13?.message}
        {...register('isbn13', { setValueAs: nullableText })}
      />
      <TextField
        id="edition-pages"
        label="Сторінок"
        type="number"
        inputMode="numeric"
        error={errors.pageCount?.message}
        {...register('pageCount', { setValueAs: nullableNumber })}
      />
      <TextField
        id="edition-cover"
        label="Обкладинка (посилання)"
        type="url"
        hint="Посилання на зображення обкладинки."
        error={errors.coverUrl?.message}
        {...register('coverUrl', { setValueAs: nullableText })}
      />
      <SelectField id="edition-format" label="Палітурка" {...register('format')}>
        {EDITION_FORMAT.map((value) => (
          <option key={value} value={value}>
            {EDITION_FORMAT_LABELS[value]}
          </option>
        ))}
      </SelectField>
    </>
  )
}

export function EditionStep({
  workId,
  translationId,
  lookup,
  initialIsbn,
  onCreated,
}: EditionStepProps) {
  const [failure, setFailure] = useState<unknown>()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateEditionRequest>({
    resolver: zodResolver(createEditionRequestSchema),
    defaultValues: defaultValues({ translationId, lookup, initialIsbn }),
  })

  async function submit(request: CreateEditionRequest): Promise<void> {
    setFailure(undefined)

    try {
      const response = await apiRequest(`/works/${workId}/editions`, {
        method: 'POST',
        body: request,
        schema: editionResponseSchema,
      })
      onCreated(response.edition.id)
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
      <EditionFields errors={errors} register={register} />
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Створюю…' : 'Далі: мій примірник'}
      </button>
    </form>
  )
}
