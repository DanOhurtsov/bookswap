'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  EDITION_FORMAT,
  type Edition,
  type EditionPatchRequest,
  type Translation,
} from '@bookswap/shared'
import { useEffect, useRef, type BaseSyntheticEvent } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
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
import {
  EDITION_TEXT_KIND_LABELS,
  editionFieldsDisplay,
  translationLabel,
} from '../model/field-display'
import { nullableNumber, nullableText } from '../model/form-values'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { useInlineEditors } from '../model/use-inline-editors'
import { ConflictNotice } from './ConflictNotice'
import { InlineField, InlineSaveHint } from './InlineField'
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

/** Display order — the first invalid one gets focus after a failed general submit. */
const EDITION_FIELDS = [
  'translationId',
  'textKind',
  'lang',
  'publisher',
  'year',
  'isbn13',
  'pageCount',
  'coverUrl',
  'format',
] as const

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
  const form = useForm<EditionCorrectionFormValues>({
    resolver: zodResolver(editionCorrectionFormSchema),
    defaultValues: toFormValues(edition),
    // `useInlineEditors.reveal` focuses the first invalid field instead.
    shouldFocusError: false,
  })
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = form
  const editors = useInlineEditors(form)
  const [translationId, textKind, lang, publisher, year, isbn13, pageCount, coverUrl, format] =
    useWatch({ control, name: [...EDITION_FIELDS] })
  const display = editionFieldsDisplay(
    { translationId, textKind, lang, publisher, year, isbn13, pageCount, coverUrl, format },
    translations,
  )

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

  // Open editors are part of the draft — see `WorkCorrectionForm`.
  function submitDraft(event?: BaseSyntheticEvent): Promise<void> {
    return handleSubmit(
      (values) => {
        editors.closeAll()
        submit(values)
      },
      (fieldErrors) => {
        editors.reveal(EDITION_FIELDS.filter((name) => fieldErrors[name] !== undefined))
      },
    )(event)
  }

  function retryAfterConflict(): void {
    if (conflict === undefined) return

    setValue('expectedRevision', conflict.revision)
    void submitDraft()
  }

  return (
    <form className="form" onSubmit={(event) => void submitDraft(event)} noValidate>
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

      <InlineField
        name="translationId"
        label="Переклад"
        display={display.translationId}
        editors={editors}
      >
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
                  {translationLabel(translation)}
                </option>
              ))}
            </SelectField>
          )}
        />
      </InlineField>
      <InlineField
        name="textKind"
        label="Що відомо про текст видання"
        display={display.textKind}
        editors={editors}
      >
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
              <option value="UNKNOWN">{EDITION_TEXT_KIND_LABELS.UNKNOWN}</option>
              <option value="ORIGINAL">{EDITION_TEXT_KIND_LABELS.ORIGINAL}</option>
              <option value="TRANSLATION">{EDITION_TEXT_KIND_LABELS.TRANSLATION}</option>
            </SelectField>
          )}
        />
      </InlineField>
      <InlineField name="lang" label="Мова видання" display={display.lang} editors={editors}>
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
      </InlineField>
      <InlineField
        name="publisher"
        label="Видавництво"
        display={display.publisher}
        editors={editors}
      >
        <TextField
          id="correction-edition-publisher"
          label="Видавництво"
          error={errors.publisher?.message}
          {...register('publisher', { setValueAs: nullableText })}
        />
      </InlineField>
      <InlineField name="year" label="Рік видання" display={display.year} editors={editors}>
        <TextField
          id="correction-edition-year"
          label="Рік видання"
          type="number"
          inputMode="numeric"
          error={errors.year?.message}
          {...register('year', { setValueAs: nullableNumber })}
        />
      </InlineField>
      <InlineField
        name="isbn13"
        label="ISBN-13"
        display={display.isbn13}
        editors={editors}
        error={isbnTakenMessage}
      >
        <TextField
          id="correction-edition-isbn"
          label="ISBN-13"
          inputMode="numeric"
          hint="Дефіси можна лишити. Контрольна сума перевіряється."
          error={isbnTakenMessage ?? errors.isbn13?.message}
          {...register('isbn13', { setValueAs: nullableText })}
        />
      </InlineField>
      <InlineField name="pageCount" label="Сторінок" display={display.pageCount} editors={editors}>
        <TextField
          id="correction-edition-pages"
          label="Сторінок"
          type="number"
          inputMode="numeric"
          error={errors.pageCount?.message}
          {...register('pageCount', { setValueAs: nullableNumber })}
        />
      </InlineField>
      <InlineField
        name="coverUrl"
        label="Обкладинка (посилання)"
        display={display.coverUrl}
        editors={editors}
      >
        <TextField
          id="correction-edition-cover"
          label="Обкладинка (посилання)"
          type="url"
          error={errors.coverUrl?.message}
          {...register('coverUrl', { setValueAs: nullableText })}
        />
      </InlineField>
      <InlineField name="format" label="Палітурка" display={display.format} editors={editors}>
        <SelectField id="correction-edition-format" label="Палітурка" {...register('format')}>
          {edition.format === null && <option value="">Не вказано</option>}
          {EDITION_FORMAT.map((value) => (
            <option key={value} value={value}>
              {EDITION_FORMAT_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </InlineField>

      <InlineSaveHint />

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
