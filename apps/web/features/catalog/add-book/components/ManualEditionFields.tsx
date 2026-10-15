'use client'

import type { EditionTextKind } from '@bookswap/shared'
import dynamic from 'next/dynamic'
import { LanguageSelect } from '@/components/Form/LanguageSelect'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import type { ManualFieldDisplay } from '../model/manual-field-view'
import { TEXT_KIND_LABELS } from '../model/manual-form'
import type { ManualDraft } from '../model/use-manual-draft'
import { ManualInlineField, ManualSectionDetails, ManualTextInlineField } from './ManualInlineField'

/** The same scanner as in search: loaded lazily, and only after an explicit press. */
const BarcodeScannerPanel = dynamic(loadBarcodeScannerPanel, { ssr: false })

const TEXT_KIND_ORDER: readonly EditionTextKind[] = ['UNKNOWN', 'ORIGINAL', 'TRANSLATION']

type ManualEditionFieldsProps = {
  draft: ManualDraft
  display: ManualFieldDisplay
}

/** What is known about the edition itself: its language, whether it is a translation, its ISBN. */
export function ManualEditionFields({ draft, display }: ManualEditionFieldsProps) {
  const { values, errors } = draft

  return (
    <>
      <ManualInlineField
        name="lang"
        label="Мова видання"
        display={display.lang}
        addLabel="Додати мову видання"
        editors={draft}
      >
        <LanguageSelect
          id="manual-lang"
          label="Мова видання"
          emptyLabel="Не вказано"
          value={values.lang}
          {...(errors.lang === undefined ? {} : { error: errors.lang })}
          onChange={(value) => {
            draft.change('lang', value)
          }}
        />
      </ManualInlineField>

      <ManualInlineField
        name="textKind"
        label="Це переклад?"
        display={display.textKind}
        addLabel="Додати відповідь"
        editors={draft}
      >
        <fieldset className="field">
          <legend>Це переклад?</legend>
          {TEXT_KIND_ORDER.map((kind) => (
            <label key={kind} className="field--checkbox">
              <input
                type="radio"
                name="manual-text-kind"
                value={kind}
                checked={values.textKind === kind}
                onChange={() => {
                  draft.change('textKind', kind)
                }}
              />{' '}
              {TEXT_KIND_LABELS[kind]}
            </label>
          ))}
        </fieldset>
      </ManualInlineField>

      {values.textKind === 'TRANSLATION' && (
        <ManualSectionDetails
          draft={draft}
          section="translation"
          summary="Переклад (необов’язково)"
        >
          <ManualTextInlineField
            draft={draft}
            name="translator"
            id="manual-translator"
            label="Перекладач"
            addLabel="Додати перекладача"
            autoComplete="off"
            display={display.translator}
          />
          <ManualInlineField
            name="translationLang"
            label="Мова перекладу"
            display={display.translationLang}
            addLabel="Додати мову перекладу"
            editors={draft}
          >
            <LanguageSelect
              id="manual-translation-lang"
              label="Мова перекладу"
              emptyLabel="Така сама, як мова видання"
              value={values.translationLang}
              {...(errors.translationLang === undefined ? {} : { error: errors.translationLang })}
              onChange={(value) => {
                draft.change('translationLang', value)
              }}
            />
          </ManualInlineField>
          <ManualInlineField
            name="translationSourceLang"
            label="З якої мови перекладено"
            display={display.translationSourceLang}
            addLabel="Додати мову, з якої перекладено"
            editors={draft}
          >
            <LanguageSelect
              id="manual-translation-source"
              label="З якої мови перекладено"
              emptyLabel="Не вказано"
              value={values.translationSourceLang}
              {...(errors.translationSourceLang === undefined
                ? {}
                : { error: errors.translationSourceLang })}
              onChange={(value) => {
                draft.change('translationSourceLang', value)
              }}
            />
          </ManualInlineField>
        </ManualSectionDetails>
      )}

      <ManualTextInlineField
        draft={draft}
        name="isbn"
        id="manual-isbn"
        label="ISBN-13"
        addLabel="Додати ISBN"
        inputMode="numeric"
        autoComplete="off"
        hint="Необов’язково. Дефіси можна лишити."
        display={display.isbn}
        // Beside the field in both modes: a scan fills the draft whether or not the editor is open.
        aside={
          <BarcodeScannerPanel
            variant="ghost"
            onValidIsbn={(isbn) => {
              draft.change('isbn', isbn)
            }}
          />
        }
      />
    </>
  )
}
