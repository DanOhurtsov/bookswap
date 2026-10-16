'use client'

import { CONDITION, VISIBILITY } from '@bookswap/shared'
import { SelectField, TextField, labelledOptions } from '@/components/Form/FormFields'
import { Button } from '@/components/ui/button'
import { CONDITION_LABELS, VISIBILITY_LABELS } from '@/app/lib/labels'
import type { CopyDraft } from '../model/use-copy-draft'

const CONDITION_OPTIONS = labelledOptions(CONDITION, CONDITION_LABELS)
const VISIBILITY_OPTIONS = labelledOptions(VISIBILITY, VISIBILITY_LABELS)

type CopyEditFormProps = {
  copyId: string
  draft: CopyDraft
  pending: boolean
  onSave: () => void
  onCancel: () => void
}

export function CopyEditForm({ copyId, draft, pending, onSave, onCancel }: CopyEditFormProps) {
  return (
    <div className="form">
      <SelectField
        id={`edit-condition-${copyId}`}
        label="Стан"
        value={draft.condition}
        options={CONDITION_OPTIONS}
        onValueChange={draft.setCondition}
      />

      <SelectField
        id={`edit-visibility-${copyId}`}
        label="Кому показувати"
        value={draft.visibility}
        options={VISIBILITY_OPTIONS}
        onValueChange={draft.setVisibility}
      />

      <TextField
        id={`edit-note-${copyId}`}
        label="Нотатка"
        hint="Видно лише вам."
        value={draft.note}
        error={draft.errors.note}
        onChange={(event) => {
          draft.setNote(event.target.value)
        }}
      />

      <TextField
        id={`edit-acquired-${copyId}`}
        label="Коли зʼявилася"
        type="date"
        value={draft.acquiredAt}
        error={draft.errors.acquiredAt}
        onChange={(event) => {
          draft.setAcquiredAt(event.target.value)
        }}
      />

      <div className="person__actions">
        <Button type="button" disabled={pending} onClick={onSave}>
          {pending ? 'Зберігаю…' : 'Зберегти'}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Скасувати
        </Button>
      </div>
    </div>
  )
}
