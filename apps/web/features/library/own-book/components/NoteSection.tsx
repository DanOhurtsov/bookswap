'use client'

import { useState, type FormEvent } from 'react'
import { TextAreaField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { parseNoteDraft } from '../model/note-draft'
import type { NoteSave } from '../model/use-own-book'

/**
 * The owner's private note. A thin component picks the mode (CLAUDE.md, "modes are components"):
 * reading and editing are two screens, and the one thing that must outlive the switch — "this was
 * just saved" — lives here.
 */
export function NoteSection({ note, noteSave }: { note: string | null; noteSave: NoteSave }) {
  const [editing, setEditing] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  function startEditing(): void {
    noteSave.clearError()
    setJustSaved(false)
    setEditing(true)
  }

  return (
    <section className="friends-section">
      <h2>Моя нотатка</h2>

      {editing ? (
        <NoteForm
          initial={note ?? ''}
          noteSave={noteSave}
          onSaved={() => {
            setEditing(false)
            setJustSaved(true)
          }}
          onCancel={() => {
            noteSave.clearError()
            setEditing(false)
          }}
        />
      ) : (
        <>
          <p>{note ?? 'Нотатки немає.'}</p>
          <p className="form__aside">Нотатку бачите лише ви.</p>
          {justSaved && <FormStatus success="Нотатку збережено." />}
          <button type="button" onClick={startEditing}>
            {note === null ? 'Додати нотатку' : 'Редагувати нотатку'}
          </button>
        </>
      )}
    </section>
  )
}

function NoteForm({
  initial,
  noteSave,
  onSaved,
  onCancel,
}: {
  initial: string
  noteSave: NoteSave
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState<string>()

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()

    const parsed = parseNoteDraft(draft)

    if (!parsed.ok) {
      setInvalid(parsed.message)

      return
    }

    setInvalid(undefined)

    if (await noteSave.save(parsed.note)) onSaved()
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <TextAreaField
        id="own-book-note"
        label="Нотатка"
        rows={4}
        value={draft}
        error={invalid}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
      />

      <FormStatus error={noteSave.error} />

      <div className="actions">
        <button type="submit" disabled={noteSave.pending}>
          {noteSave.pending ? 'Зберігаю…' : 'Зберегти'}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={noteSave.pending}
          onClick={onCancel}
        >
          Скасувати
        </button>
      </div>
    </form>
  )
}
