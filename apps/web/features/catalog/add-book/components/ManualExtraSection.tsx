'use client'

import { EDITION_FORMAT } from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { SelectField } from '@/components/Form/FormFields'
import type { ManualFieldDisplay } from '../model/manual-field-view'
import type { ManualDraft } from '../model/use-manual-draft'
import { ManualInlineField, ManualSectionDetails, ManualTextInlineField } from './ManualInlineField'

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
          onChange={(event) => {
            const { value } = event.target

            draft.change('format', EDITION_FORMAT.find((format) => format === value) ?? '')
          }}
        >
          <option value="">Не вказано</option>
          {EDITION_FORMAT.map((value) => (
            <option key={value} value={value}>
              {EDITION_FORMAT_LABELS[value]}
            </option>
          ))}
        </SelectField>
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
