'use client'

import { EDITION_FORMAT, type EditionTextKind, type QuickAddManualTarget } from '@bookswap/shared'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { LanguageSelect } from '@/components/Form/LanguageSelect'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import {
  buildManualTarget,
  type ManualFieldErrors,
  type ManualFormValues,
} from '../model/manual-form'
import type { QuickAddSlot } from '../model/quick-add-slots'

/** Той самий сканер, що й у пошуку: ліниво й лише після явного натискання. */
const BarcodeScannerPanel = dynamic(loadBarcodeScannerPanel, { ssr: false })

type ManualAddFormProps = {
  initial: ManualFormValues
  /** Наявний твір («Уточнити видання», сторінка твору): назва не редагується, нового твору не буде. */
  presetWork?: { id: string; title: string }
  slot: QuickAddSlot | undefined
  onSubmit: (target: QuickAddManualTarget) => void
  /** Повтор ТІЄЇ САМОЇ операції після невизначеного результату. */
  onRetry: () => void
  onUseExistingEdition: (editionId: string) => void
  onAddAnother: () => void
}

const TEXT_KIND_OPTIONS: readonly { value: EditionTextKind; label: string }[] = [
  { value: 'UNKNOWN', label: 'Не знаю' },
  { value: 'ORIGINAL', label: 'Ні — це оригінал' },
  { value: 'TRANSLATION', label: 'Так — це переклад' },
]

function existingEditionIdOf(slot: QuickAddSlot | undefined): string | undefined {
  if (slot?.status !== 'rejected' || slot.code !== 'EDITION_ISBN_TAKEN') return undefined

  const details = slot.details

  return typeof details === 'object' &&
    details !== null &&
    'editionId' in details &&
    typeof details.editionId === 'string'
    ? details.editionId
    : undefined
}

/**
 * Єдина компактна форма ручного додавання (docs/plan/fast-book-add.md, §2.4): обов'язкова лише назва; автор,
 * мова видання, ISBN і видавничі дані — необов'язкові, невідоме лишається невідомим й уточнюється пізніше.
 *
 * «Додати до бібліотеки» зберігає ВСЕ введене й примірник однією операцією. Після невизначеного результату
 * поля заблоковані: повторюється та сама операція з незмінним вмістом, нова неможлива, доки результат не
 * з'ясовано. Однозначна відмова повертає форму до редагування з тим самим введеним.
 */
export function ManualAddForm({
  initial,
  presetWork,
  slot,
  onSubmit,
  onRetry,
  onUseExistingEdition,
  onAddAnother,
}: ManualAddFormProps) {
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<ManualFieldErrors>({})
  const pending = slot?.status === 'pending'
  const unknown = slot?.status === 'unknown'
  const locked = pending || unknown
  const existingEditionId = existingEditionIdOf(slot)

  function change<K extends keyof ManualFormValues>(key: K, value: ManualFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }))
  }

  if (slot?.status === 'done') {
    return (
      <div className="alert alert--ok" role="status">
        <p>Книжку додано до вашої бібліотеки.</p>
        <button type="button" onClick={onAddAnother}>
          Додати ще одну книжку
        </button>
      </div>
    )
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()

        if (locked) return

        const built = buildManualTarget(values, presetWork?.id)

        if (built.ok) {
          setErrors({})
          onSubmit(built.target)
        } else {
          setErrors(built.errors)
        }
      }}
    >
      {errors.form !== undefined && <FormStatus error={new Error(errors.form)} />}

      {slot?.status === 'rejected' && existingEditionId === undefined && (
        <FormStatus error={new Error(slot.message)} />
      )}

      {unknown && (
        <p className="alert alert--warn" role="alert">
          Не вдалося підтвердити додавання. Книжку не буде додано вдруге — перевірте ще раз.
        </p>
      )}

      <fieldset disabled={locked} className="form">
        {presetWork === undefined ? (
          <TextField
            id="manual-title"
            label="Назва"
            required
            autoComplete="off"
            value={values.title}
            {...(errors.title === undefined ? {} : { error: errors.title })}
            onChange={(event) => {
              change('title', event.target.value)
            }}
          />
        ) : (
          <p>
            Твір: <strong>{presetWork.title}</strong>. Додаємо його видання.
          </p>
        )}

        {presetWork === undefined && (
          <div className="field">
            <label htmlFor="manual-author-0">Автор</label>
            {values.authors.map((name, index) => (
              <div key={index} className="person__actions">
                <input
                  id={`manual-author-${String(index)}`}
                  aria-label={index === 0 ? 'Автор' : `Автор ${String(index + 1)}`}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => {
                    change(
                      'authors',
                      values.authors.map((current, position) =>
                        position === index ? event.target.value : current,
                      ),
                    )
                  }}
                />
                {values.authors.length > 1 && (
                  <button
                    type="button"
                    className="button--ghost"
                    aria-label={`Прибрати автора ${String(index + 1)}`}
                    onClick={() => {
                      change(
                        'authors',
                        values.authors.filter((_, position) => position !== index),
                      )
                    }}
                  >
                    Прибрати
                  </button>
                )}
              </div>
            ))}
            {values.authors.length < 10 && (
              <button
                type="button"
                className="button--ghost"
                onClick={() => {
                  change('authors', [...values.authors, ''])
                }}
              >
                Додати автора
              </button>
            )}
            {errors.authors !== undefined && (
              <p className="field__error" role="alert">
                {errors.authors}
              </p>
            )}
          </div>
        )}

        <LanguageSelect
          id="manual-lang"
          label="Мова видання"
          emptyLabel="Не вказано"
          value={values.lang}
          {...(errors.lang === undefined ? {} : { error: errors.lang })}
          onChange={(value) => {
            change('lang', value)
          }}
        />

        <fieldset className="field">
          <legend>Це переклад?</legend>
          {TEXT_KIND_OPTIONS.map((option) => (
            <label key={option.value} className="field--checkbox">
              <input
                type="radio"
                name="manual-text-kind"
                value={option.value}
                checked={values.textKind === option.value}
                onChange={() => {
                  change('textKind', option.value)
                }}
              />{' '}
              {option.label}
            </label>
          ))}
        </fieldset>

        {values.textKind === 'TRANSLATION' && (
          <details open={values.translator !== ''}>
            <summary>Переклад (необов’язково)</summary>
            <TextField
              id="manual-translator"
              label="Перекладач"
              autoComplete="off"
              value={values.translator}
              {...(errors.translator === undefined ? {} : { error: errors.translator })}
              onChange={(event) => {
                change('translator', event.target.value)
              }}
            />
            <LanguageSelect
              id="manual-translation-lang"
              label="Мова перекладу"
              emptyLabel="Така сама, як мова видання"
              value={values.translationLang}
              {...(errors.translationLang === undefined ? {} : { error: errors.translationLang })}
              onChange={(value) => {
                change('translationLang', value)
              }}
            />
            <LanguageSelect
              id="manual-translation-source"
              label="З якої мови перекладено"
              emptyLabel="Не вказано"
              value={values.translationSourceLang}
              {...(errors.translationSourceLang === undefined
                ? {}
                : { error: errors.translationSourceLang })}
              onChange={(value) => {
                change('translationSourceLang', value)
              }}
            />
          </details>
        )}

        <TextField
          id="manual-isbn"
          label="ISBN-13"
          inputMode="numeric"
          autoComplete="off"
          hint="Необов’язково. Дефіси можна лишити."
          value={values.isbn}
          {...(errors.isbn === undefined ? {} : { error: errors.isbn })}
          onChange={(event) => {
            change('isbn', event.target.value)
          }}
        />
        <BarcodeScannerPanel
          onValidIsbn={(isbn) => {
            change('isbn', isbn)
          }}
        />

        {existingEditionId !== undefined && (
          <div className="alert alert--warn" role="alert">
            <p>Видання з таким ISBN уже є в каталозі BookSwap.</p>
            <button
              type="button"
              onClick={() => {
                onUseExistingEdition(existingEditionId)
              }}
            >
              Додати наявне видання
            </button>
          </div>
        )}

        <details>
          <summary>Додатково</summary>
          <TextField
            id="manual-publisher"
            label="Видавництво"
            value={values.publisher}
            {...(errors.publisher === undefined ? {} : { error: errors.publisher })}
            onChange={(event) => {
              change('publisher', event.target.value)
            }}
          />
          <TextField
            id="manual-year"
            label="Рік видання"
            inputMode="numeric"
            value={values.year}
            {...(errors.year === undefined ? {} : { error: errors.year })}
            onChange={(event) => {
              change('year', event.target.value)
            }}
          />
          <TextField
            id="manual-pages"
            label="Сторінок"
            inputMode="numeric"
            value={values.pageCount}
            {...(errors.pageCount === undefined ? {} : { error: errors.pageCount })}
            onChange={(event) => {
              change('pageCount', event.target.value)
            }}
          />
          <SelectField
            id="manual-format"
            label="Палітурка"
            value={values.format}
            onChange={(event) => {
              change('format', event.target.value as ManualFormValues['format'])
            }}
          >
            <option value="">Не вказано</option>
            {EDITION_FORMAT.map((value) => (
              <option key={value} value={value}>
                {EDITION_FORMAT_LABELS[value]}
              </option>
            ))}
          </SelectField>
          <TextField
            id="manual-cover"
            label="Обкладинка (посилання)"
            type="url"
            value={values.coverUrl}
            {...(errors.coverUrl === undefined ? {} : { error: errors.coverUrl })}
            onChange={(event) => {
              change('coverUrl', event.target.value)
            }}
          />
          {presetWork === undefined && (
            <TextField
              id="manual-first-year"
              label="Рік першого видання твору"
              inputMode="numeric"
              value={values.firstPubYear}
              {...(errors.firstPubYear === undefined ? {} : { error: errors.firstPubYear })}
              onChange={(event) => {
                change('firstPubYear', event.target.value)
              }}
            />
          )}
        </details>
      </fieldset>

      {unknown ? (
        <button type="button" onClick={onRetry}>
          Перевірити ще раз
        </button>
      ) : (
        <button type="submit" aria-disabled={pending} aria-busy={pending}>
          {pending ? 'Додаю…' : 'Додати до бібліотеки'}
        </button>
      )}
    </form>
  )
}
