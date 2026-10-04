'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  EDITION_FORMAT,
  type Edition,
  type EditionPatchRequest,
  type Translation,
} from '@bookswap/shared'
import { useEffect, useRef } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { ApiRequestError } from '@/app/lib/api'
import type { WorkReloadOutcome } from '@/app/lib/use-catalog'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { LanguageSelect } from '@/components/Form/LanguageSelect'
import { FormStatus } from '@/components/Form/FormStatus'
import { parseEditionConflict } from '../api/correction-requests'
import {
  editionCorrectionFormSchema,
  type EditionCorrectionFormValues,
} from '../model/edition-form'
import { nullableNumber, nullableText } from '../model/form-values'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { ConflictNotice } from './ConflictNotice'
import { RefreshNotice } from './RefreshNotice'

type EditionCorrectionFormProps = {
  /** Already reconciled with the correction overlay — see `correction.resolve` at the call site. */
  edition: Edition
  /** The Work's own translations — R10: `translationId` must stay within it. */
  translations: Translation[]
  correction: CatalogCorrection<EditionPatchRequest, Edition>
  reload: () => Promise<WorkReloadOutcome>
  onClose: () => void
}

function toFormValues(edition: Edition): EditionCorrectionFormValues {
  return {
    translationId: edition.translationId,
    textKind: edition.textKind,
    lang: edition.lang,
    publisher: edition.publisher,
    year: edition.year,
    isbn13: edition.isbn13,
    pageCount: edition.pageCount,
    coverUrl: edition.coverUrl,
    format: edition.format ?? '',
    expectedRevision: edition.revision,
  }
}

/**
 * R10: Edition correction, including reassigning `translationId` within the
 * same Work. `correction` is owned by the stable card that renders this form
 * (see `EditionCard`), so a confirmed save survives closing the form.
 */
export function EditionCorrectionForm({
  edition,
  translations,
  correction,
  reload,
  onClose,
}: EditionCorrectionFormProps) {
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<EditionCorrectionFormValues>({
    resolver: zodResolver(editionCorrectionFormSchema),
    defaultValues: toFormValues(edition),
  })

  // `correction.confirmed` outlives this form closing — a REOPENED form must
  // not re-apply a save from BEFORE it mounted. Seeded with whatever
  // `confirmed` already held at mount, so that value counts as "nothing new
  // yet"; only a LATER change (a save made while THIS form is open) applies.
  const appliedConfirmedRef = useRef(correction.confirmed)

  useEffect(() => {
    if (correction.confirmed === undefined) return
    if (correction.confirmed === appliedConfirmedRef.current) return

    appliedConfirmedRef.current = correction.confirmed
    setValue('expectedRevision', correction.confirmed.revision, { shouldDirty: false })
  }, [correction.confirmed, setValue])

  const conflict =
    correction.saveError instanceof ApiRequestError &&
    correction.saveError.code === 'CATALOG_REVISION_CONFLICT'
      ? parseEditionConflict(correction.saveError.details)
      : undefined

  const isbnTakenMessage =
    correction.saveError instanceof ApiRequestError &&
    correction.saveError.code === 'EDITION_ISBN_TAKEN'
      ? correction.saveError.message
      : undefined

  function submit(values: EditionCorrectionFormValues): void {
    const { format, textKind, lang, ...rest } = values

    // Тип тексту й мова йдуть у запит лише коли їх змінено руками: інакше збереження видавництва могло б
    // перезаписати тип тексту, виведений зі зміни перекладу, застарілим значенням форми.
    correction.submit(
      {
        ...rest,
        ...(format === '' ? {} : { format }),
        ...(dirtyFields.textKind === true ? { textKind } : {}),
        ...(dirtyFields.lang === true ? { lang } : {}),
      },
      { ...edition, ...rest, textKind, lang, format: format === '' ? edition.format : format },
    )
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
            <dt>Видавництво зараз на сервері</dt>
            <dd>{conflict.publisher ?? '—'}</dd>
          </dl>
        </ConflictNotice>
      ) : (
        <FormStatus
          // Shown on the ISBN field itself instead (below) — more actionable there.
          error={isbnTakenMessage === undefined ? correction.saveError : undefined}
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

      <Controller
        control={control}
        name="translationId"
        render={({ field }) => (
          <SelectField
            id="correction-edition-translation"
            label="Переклад"
            value={field.value ?? ''}
            onChange={(event) => {
              field.onChange(event.target.value === '' ? null : event.target.value)
            }}
          >
            <option value="">Без привʼязки до перекладу</option>
            {translations.map((translation) => (
              <option key={translation.id} value={translation.id}>
                {translation.translator} ({translation.lang})
              </option>
            ))}
          </SelectField>
        )}
      />
      <Controller
        control={control}
        name="textKind"
        render={({ field }) => (
          <SelectField
            id="correction-edition-text-kind"
            label="Що відомо про текст видання"
            hint="Відсутність перекладу не означає, що це оригінал."
            value={field.value}
            onChange={(event) => {
              field.onChange(event.target.value)
            }}
          >
            <option value="UNKNOWN">Невідомо: оригінал чи переклад</option>
            <option value="ORIGINAL">Оригінал</option>
            <option value="TRANSLATION">Переклад</option>
          </SelectField>
        )}
      />
      <Controller
        control={control}
        name="lang"
        render={({ field }) => (
          <LanguageSelect
            id="correction-edition-lang"
            label="Мова видання"
            hint="Мова цього видання не доводить мови оригіналу."
            value={field.value ?? ''}
            emptyLabel="Не вказано"
            onChange={(value) => {
              field.onChange(value === '' ? null : value)
            }}
          />
        )}
      />
      <TextField
        id="correction-edition-publisher"
        label="Видавництво"
        error={errors.publisher?.message}
        {...register('publisher', { setValueAs: nullableText })}
      />
      <TextField
        id="correction-edition-year"
        label="Рік видання"
        type="number"
        inputMode="numeric"
        error={errors.year?.message}
        {...register('year', { setValueAs: nullableNumber })}
      />
      <TextField
        id="correction-edition-isbn"
        label="ISBN-13"
        inputMode="numeric"
        hint="Дефіси можна лишити. Контрольна сума перевіряється."
        error={isbnTakenMessage ?? errors.isbn13?.message}
        {...register('isbn13', { setValueAs: nullableText })}
      />
      <TextField
        id="correction-edition-pages"
        label="Сторінок"
        type="number"
        inputMode="numeric"
        error={errors.pageCount?.message}
        {...register('pageCount', { setValueAs: nullableNumber })}
      />
      <TextField
        id="correction-edition-cover"
        label="Обкладинка (посилання)"
        type="url"
        error={errors.coverUrl?.message}
        {...register('coverUrl', { setValueAs: nullableText })}
      />
      <SelectField id="correction-edition-format" label="Палітурка" {...register('format')}>
        {edition.format === null && <option value="">Не вказано</option>}
        {EDITION_FORMAT.map((value) => (
          <option key={value} value={value}>
            {EDITION_FORMAT_LABELS[value]}
          </option>
        ))}
      </SelectField>

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
