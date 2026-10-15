'use client'

import type { QuickAddManualTarget } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { manualFieldDisplay } from '../model/manual-field-view'
import type { ManualFormValues } from '../model/manual-form'
import type { QuickAddSlot } from '../model/quick-add-slots'
import { useManualDraft } from '../model/use-manual-draft'
import { ManualAuthorsField } from './ManualAuthorsField'
import { ManualEditionFields } from './ManualEditionFields'
import { ManualExtraSection } from './ManualExtraSection'
import { ManualTextInlineField } from './ManualInlineField'

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
 * The one compact manual-add form (docs/plan/fast-book-add.md, §2.4): only the title is required; author,
 * edition language, ISBN and publishing details are optional, and the unknown stays unknown until refined.
 *
 * Every field reads as text with its own local editor (BS-76); an editor's «Зберегти»/«Скасувати» only touch
 * the draft. «Додати до бібліотеки» is the one action that sends anything: it saves EVERYTHING entered —
 * open editors included — and the copy as one operation. After an unknown outcome the fields are locked: the
 * same operation is retried with unchanged content, and no new one can start until the outcome is known. An
 * unambiguous rejection returns the form to editing with the same input.
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
  const draft = useManualDraft(initial, presetWork?.id)
  const display = manualFieldDisplay(draft.values)
  const pending = slot?.status === 'pending'
  const unknown = slot?.status === 'unknown'
  const locked = pending || unknown
  const existingEditionId = existingEditionIdOf(slot)

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

        const target = draft.submit()

        if (target !== undefined) onSubmit(target)
      }}
    >
      {draft.errors.form !== undefined && <FormStatus error={new Error(draft.errors.form)} />}

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
          <>
            <ManualTextInlineField
              draft={draft}
              name="title"
              id="manual-title"
              label="Назва"
              addLabel="Додати назву"
              required
              autoComplete="off"
              display={display.title}
            />
            <ManualAuthorsField draft={draft} names={display.authors} />
          </>
        ) : (
          <p>
            Твір: <strong>{presetWork.title}</strong>. Додаємо його видання.
          </p>
        )}

        <ManualEditionFields draft={draft} display={display} />

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

        <ManualExtraSection
          draft={draft}
          display={display}
          hasPresetWork={presetWork !== undefined}
        />
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
