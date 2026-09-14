'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import type { Work, WorkAuthor, WorkPatchRequest } from '@bookswap/shared'
import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'
import { ApiRequestError } from '@/app/lib/api'
import type { WorkReloadOutcome } from '@/app/lib/use-catalog'
import { TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { parseWorkConflict, type WorkCorrectionEntity } from '../api/correction-requests'
import {
  authorLookup,
  authorsEqual,
  toAuthorFormValues,
  type AuthorFormValue,
} from '../model/author-list'
import { nullableNumber, nullableText } from '../model/form-values'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { workCorrectionFormSchema, type WorkCorrectionFormValues } from '../model/work-form'
import { AuthorListEditor } from './AuthorListEditor'
import { ConflictNotice } from './ConflictNotice'
import { LanguageField } from './LanguageField'
import { RefreshNotice } from './RefreshNotice'

type WorkCorrectionFormProps = {
  /** Already reconciled with the correction overlay — see `correction.resolve` at the call site. */
  work: Work
  authors: WorkAuthor[]
  correction: CatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>
  reload: () => Promise<WorkReloadOutcome>
  onClose: () => void
}

function toFormValues(work: Work, authors: WorkAuthor[]): WorkCorrectionFormValues {
  return {
    title: work.title,
    origLang: work.origLang,
    firstPubYear: work.firstPubYear,
    description: work.description,
    authors: toAuthorFormValues(authors),
    expectedRevision: work.revision,
  }
}

function isWorkMergedDetails(details: unknown): details is { canonicalWorkId: string } {
  return (
    typeof details === 'object' &&
    details !== null &&
    'canonicalWorkId' in details &&
    typeof (details as { canonicalWorkId: unknown }).canonicalWorkId === 'string'
  )
}

/**
 * First end-to-end 8e-3 scenario: open a Work, edit the title, save, see the
 * new title without a manual page reload. Everything else here (conflict,
 * merged-work, optimistic overlay/rollback) exists to make that one path
 * safe, not to add scope beyond it.
 *
 * `correction` is owned by a stable ancestor (the page, so `<h1>`/`AuthorLine`
 * see it too) and passed in — this component only renders inputs against it,
 * so closing this form does not lose a confirmed-but-not-yet-refreshed save.
 */
export function WorkCorrectionForm({
  work,
  authors,
  correction,
  reload,
  onClose,
}: WorkCorrectionFormProps) {
  const router = useRouter()

  const {
    control,
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WorkCorrectionFormValues>({
    resolver: zodResolver(workCorrectionFormSchema),
    defaultValues: toFormValues(work, authors),
  })

  // Pinned to what the form opened with — R10a: `authors` is sent only when
  // it actually changed FROM THAT POINT. Updated after a successful save (see
  // the effect below) so a later, unrelated edit does not re-diff against a
  // pre-save snapshot and re-declare an already-saved author "changed".
  const baselineAuthorsRef = useRef(toAuthorFormValues(authors))
  // What the LAST submit actually sent for `authors` — used only to decide
  // whether it is safe to silently back-fill server-assigned author ids into
  // the visible field (below): safe exactly when nothing has touched that
  // field since. If the user kept editing authors further in the meantime,
  // the back-fill is skipped and their in-progress edit is left alone.
  const lastSubmittedAuthorsRef = useRef<AuthorFormValue[] | undefined>(undefined)

  // `correction.confirmed` lives in the stable ancestor and outlives this
  // form closing — a REOPENED form must not re-apply a save from BEFORE it
  // mounted (stale `expectedRevision`, stale author ids overwriting the
  // fresh baseline `toFormValues(work, authors)` already used above). This
  // ref remembers which `confirmed` this instance has already reacted to —
  // seeded with whatever `confirmed` already held AT MOUNT, so that exact
  // (possibly stale) value is treated as "nothing new happened yet", and only
  // a LATER change (a save made while THIS form is open) is applied.
  const appliedConfirmedRef = useRef(correction.confirmed)

  // After a successful PATCH made BY THIS FORM: adopt the server's revision
  // and (for authors) its assigned ids/order — never touch title/origLang/
  // etc, which the user may already be editing again by the time this runs
  // (R12/§3.9: "don't erase input made after submit").
  useEffect(() => {
    if (correction.confirmed === undefined) return
    if (correction.confirmed === appliedConfirmedRef.current) return

    appliedConfirmedRef.current = correction.confirmed

    const { work: confirmedWork, authors: confirmedAuthors } = correction.confirmed

    setValue('expectedRevision', confirmedWork.revision, { shouldDirty: false })

    const freshAuthorValues = toAuthorFormValues(confirmedAuthors)
    const submitted = lastSubmittedAuthorsRef.current

    if (submitted !== undefined && authorsEqual(getValues('authors'), submitted)) {
      setValue('authors', freshAuthorValues, { shouldDirty: false })
    }

    baselineAuthorsRef.current = freshAuthorValues
  }, [correction.confirmed, setValue, getValues])

  const mergedInto =
    correction.saveError instanceof ApiRequestError &&
    correction.saveError.code === 'WORK_MERGED' &&
    isWorkMergedDetails(correction.saveError.details)
      ? correction.saveError.details.canonicalWorkId
      : undefined

  // §6.3: the same redirect the page does for a GET-time 301 — a Work merged
  // away between page load and this PATCH is not a dead end, it is a move.
  useEffect(() => {
    if (mergedInto !== undefined) router.replace(`/works/${encodeURIComponent(mergedInto)}`)
  }, [mergedInto, router])

  const conflict =
    correction.saveError instanceof ApiRequestError &&
    correction.saveError.code === 'CATALOG_REVISION_CONFLICT'
      ? parseWorkConflict(correction.saveError.details)
      : undefined

  function submit(values: WorkCorrectionFormValues): void {
    const authorsChanged = !authorsEqual(values.authors, baselineAuthorsRef.current)

    lastSubmittedAuthorsRef.current = values.authors

    const body: WorkPatchRequest = {
      title: values.title,
      origLang: values.origLang,
      firstPubYear: values.firstPubYear,
      description: values.description,
      expectedRevision: values.expectedRevision,
      ...(authorsChanged ? { authors: values.authors } : {}),
    }

    correction.submit(body, {
      work: {
        ...work,
        title: values.title,
        origLang: values.origLang,
        firstPubYear: values.firstPubYear,
        description: values.description,
      },
      // Reconstructing a faithful `WorkAuthor[]` guess for new/reordered
      // authors would need server-assigned ids this form does not have —
      // the author list stays on last-confirmed data until the PATCH
      // response itself brings the authoritative one.
      authors,
    })
  }

  function retryAfterConflict(): void {
    if (conflict === undefined) return

    setValue('expectedRevision', conflict.work.revision)
    void handleSubmit(submit)()
  }

  if (mergedInto !== undefined) {
    return (
      <div className="alert alert--warn" role="alert">
        <p>
          Цей твір обʼєднано з іншим — переадресовую на актуальну версію…{' '}
          <a href={`/works/${mergedInto}`}>перейти вручну</a>.
        </p>
      </div>
    )
  }

  return (
    <form className="form" onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
      <p className="form__aside">
        Це спільні метадані каталогу — їх бачить кожен, хто відкриє цей твір, а не лише ваш
        примірник.
      </p>

      {conflict !== undefined ? (
        <ConflictNotice onRetry={retryAfterConflict}>
          <dl className="facts">
            <dt>Назва зараз на сервері</dt>
            <dd>{conflict.work.title}</dd>
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
        id="correction-work-title"
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
            id="correction-work-lang"
            label="Мова оригіналу"
            value={field.value ?? ''}
            error={errors.origLang?.message}
            onChange={field.onChange}
          />
        )}
      />
      <TextField
        id="correction-work-year"
        label="Рік першого видання"
        type="number"
        inputMode="numeric"
        error={errors.firstPubYear?.message}
        {...register('firstPubYear', { setValueAs: nullableNumber })}
      />
      <TextAreaField
        id="correction-work-description"
        label="Опис"
        rows={3}
        error={errors.description?.message}
        {...register('description', { setValueAs: nullableText })}
      />

      <AuthorListEditor control={control} errors={errors} knownAuthors={authorLookup(authors)} />

      <div className="person__actions">
        <button type="submit" disabled={isSubmitting || correction.isSaving}>
          {isSubmitting || correction.isSaving ? 'Зберігаю…' : 'Зберегти'}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={isSubmitting || correction.isSaving}
          onClick={() => {
            reset(toFormValues(work, authors))
            onClose()
          }}
        >
          Закрити
        </button>
      </div>
    </form>
  )
}
