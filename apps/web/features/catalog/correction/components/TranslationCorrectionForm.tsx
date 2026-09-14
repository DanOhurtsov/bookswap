'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import type { Translation, TranslationPatchRequest } from '@bookswap/shared'
import { useEffect, useRef } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { ApiRequestError } from '@/app/lib/api'
import type { WorkReloadOutcome } from '@/app/lib/use-catalog'
import { TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { parseTranslationConflict } from '../api/correction-requests'
import { nullableNumber } from '../model/form-values'
import {
  translationCorrectionFormSchema,
  type TranslationCorrectionFormValues,
} from '../model/translation-form'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { ConflictNotice } from './ConflictNotice'
import { LanguageField } from './LanguageField'
import { RefreshNotice } from './RefreshNotice'

type TranslationCorrectionFormProps = {
  /** Already reconciled with the correction overlay — see `correction.resolve` at the call site. */
  translation: Translation
  correction: CatalogCorrection<TranslationPatchRequest, Translation>
  reload: () => Promise<WorkReloadOutcome>
  onClose: () => void
}

function toFormValues(translation: Translation): TranslationCorrectionFormValues {
  return {
    translator: translation.translator,
    lang: translation.lang,
    sourceLang: translation.sourceLang,
    year: translation.year,
    isAbridged: translation.isAbridged,
    hasNotes: translation.hasNotes,
    notes: translation.notes,
    expectedRevision: translation.revision,
  }
}

/**
 * R10: Translation correction — same shape as the create form, plus
 * conflict/rollback (R12). `correction` is owned by the stable card that
 * renders this form (see `TranslationCard`), not by this component, so a
 * confirmed save survives closing the form.
 */
export function TranslationCorrectionForm({
  translation,
  correction,
  reload,
  onClose,
}: TranslationCorrectionFormProps) {
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TranslationCorrectionFormValues>({
    resolver: zodResolver(translationCorrectionFormSchema),
    defaultValues: toFormValues(translation),
  })

  // `correction.confirmed` outlives this form closing — a REOPENED form must
  // not re-apply a save from BEFORE it mounted. Seeded with whatever
  // `confirmed` already held at mount, so that value counts as "nothing new
  // yet"; only a LATER change (a save made while THIS form is open) applies.
  const appliedConfirmedRef = useRef(correction.confirmed)

  // After a successful PATCH made BY THIS FORM, adopt the server's revision —
  // never the user-visible fields, which may already hold a newer, unsaved
  // edit by the time this runs (R12/§3.9).
  useEffect(() => {
    if (correction.confirmed === undefined) return
    if (correction.confirmed === appliedConfirmedRef.current) return

    appliedConfirmedRef.current = correction.confirmed
    setValue('expectedRevision', correction.confirmed.revision, { shouldDirty: false })
  }, [correction.confirmed, setValue])

  const conflict =
    correction.saveError instanceof ApiRequestError &&
    correction.saveError.code === 'CATALOG_REVISION_CONFLICT'
      ? parseTranslationConflict(correction.saveError.details)
      : undefined

  function submit(values: TranslationCorrectionFormValues): void {
    correction.submit(values, { ...translation, ...values })
  }

  function retryAfterConflict(): void {
    if (conflict === undefined) return

    setValue('expectedRevision', conflict.revision)
    void handleSubmit(submit)()
  }

  return (
    <form className="form" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
      <p className="form__aside">
        Це спільні метадані каталогу — їх бачить кожен, хто відкриє цей твір.
      </p>

      {conflict !== undefined ? (
        <ConflictNotice onRetry={retryAfterConflict}>
          <dl className="facts">
            <dt>Перекладач зараз на сервері</dt>
            <dd>{conflict.translator}</dd>
          </dl>
        </ConflictNotice>
      ) : (
        <FormStatus
          error={correction.saveError}
          success={correction.justSaved && !correction.isSaving ? 'Збережено.' : undefined}
        />
      )}

      {correction.refreshNotice !== undefined && (
        <RefreshNotice
          message={correction.refreshNotice}
          onRetry={() => void reload()}
          onDismiss={correction.dismissRefreshNotice}
        />
      )}

      <TextField
        id="correction-translation-translator"
        label="Перекладач"
        required
        error={errors.translator?.message}
        {...register('translator')}
      />
      <Controller
        control={control}
        name="lang"
        render={({ field }) => (
          <LanguageField
            id="correction-translation-lang"
            label="Мова перекладу"
            value={field.value}
            error={errors.lang?.message}
            onChange={field.onChange}
          />
        )}
      />
      <Controller
        control={control}
        name="sourceLang"
        render={({ field }) => (
          <LanguageField
            id="correction-translation-source"
            label="З якої мови перекладено"
            value={field.value}
            error={errors.sourceLang?.message}
            onChange={field.onChange}
          />
        )}
      />
      <TextField
        id="correction-translation-year"
        label="Рік перекладу"
        type="number"
        inputMode="numeric"
        error={errors.year?.message}
        {...register('year', { setValueAs: nullableNumber })}
      />
      <div className="field field--checkbox">
        <input id="correction-translation-abridged" type="checkbox" {...register('isAbridged')} />
        <label htmlFor="correction-translation-abridged">Скорочений переклад</label>
      </div>
      <div className="field field--checkbox">
        <input id="correction-translation-has-notes" type="checkbox" {...register('hasNotes')} />
        <label htmlFor="correction-translation-has-notes">Є примітки й коментарі перекладача</label>
      </div>
      <TextAreaField
        id="correction-translation-notes"
        label="Примітки"
        rows={3}
        error={errors.notes?.message}
        {...register('notes', { setValueAs: (value: unknown) => (value === '' ? null : value) })}
      />

      <div className="person__actions">
        <button type="submit" disabled={isSubmitting || correction.isSaving}>
          {isSubmitting || correction.isSaving ? 'Зберігаю…' : 'Зберегти'}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={isSubmitting || correction.isSaving}
          onClick={onClose}
        >
          Закрити
        </button>
      </div>
    </form>
  )
}
