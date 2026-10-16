'use client'

import { EDITION_FORMAT } from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { SelectField, labelledOptions } from '@/components/Form/FormFields'
import type { ManualFieldDisplay } from '../model/manual-field-view'
import type { ManualDraft } from '../model/use-manual-draft'
import { ManualInlineField, ManualSectionDetails, ManualTextInlineField } from './ManualInlineField'

/** `''` — the binding is not known. */
const FORMAT_OPTIONS = [
  { value: '' as const, label: 'Не вказано' },
  ...labelledOptions(EDITION_FORMAT, EDITION_FORMAT_LABELS),
]

type ManualExtraSectionProps = {
  draft: ManualDraft
  display: ManualFieldDisplay
  /** An existing work owns its first publication year: the field is not offered. */
  hasPresetWork: boolean
}

/** «Додатково»: the publishing details, collapsed until wanted. */
export function ManualExtraSection({ draft, display, hasPresetWork }: ManualExtraSectionProps) {
  return (
    <ManualSectionDetails draft={draft} section="extra" summary="Додатково">
      <ManualTextInlineField
        draft={draft}
        name="publisher"
        id="manual-publisher"
        label="Видавництво"
        addLabel="Додати видавництво"
        display={display.publisher}
      />
      <ManualTextInlineField
        draft={draft}
        name="year"
        id="manual-year"
        label="Рік видання"
        addLabel="Додати рік видання"
        inputMode="numeric"
        display={display.year}
      />
      <ManualTextInlineField
        draft={draft}
        name="pageCount"
        id="manual-pages"
        label="Сторінок"
        addLabel="Додати кількість сторінок"
        inputMode="numeric"
        display={display.pageCount}
      />
      <ManualInlineField
        name="format"
        label="Палітурка"
        display={display.format}
        addLabel="Додати палітурку"
        editors={draft}
      >
        <SelectField
          id="manual-format"
          label="Палітурка"
          value={draft.values.format}
          options={FORMAT_OPTIONS}
          onValueChange={(format) => {
            draft.change('format', format)
          }}
        />
      </ManualInlineField>
      <ManualTextInlineField
        draft={draft}
        name="coverUrl"
        id="manual-cover"
        label="Обкладинка (посилання)"
        addLabel="Додати посилання на обкладинку"
        type="url"
        display={display.coverUrl}
      />
      {!hasPresetWork && (
        <ManualTextInlineField
          draft={draft}
          name="firstPubYear"
          id="manual-first-year"
          label="Рік першого видання твору"
          addLabel="Додати рік першого видання"
          inputMode="numeric"
          display={display.firstPubYear}
        />
      )}
    </ManualSectionDetails>
  )
}
