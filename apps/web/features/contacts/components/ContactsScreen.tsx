'use client'

import { useState, type FormEvent } from 'react'
import {
  createExternalBorrowerRequestSchema,
  updateExternalBorrowerRequestSchema,
  type ExternalBorrower,
} from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { validate } from '@/app/lib/validation'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { createContact, renameContact } from '../api/contacts-requests'
import { useContacts } from '../model/use-contacts'

const toError = (error: unknown): Error =>
  error instanceof ApiRequestError ? error : new Error(describeError(error))

/**
 * 10f.2: the owner's private list of contacts. Rendered only when the server says the
 * feature is on (`features.guestLoans`); the flag itself never lives in client env.
 *
 * The create form is mounted only once the list has loaded, so a created contact always lands in it.
 * The checkbox is the owner's own statement that they told the person. It is not the
 * person's confirmation and not a legal basis (D2 is still open), and the text must not say so.
 */
export function ContactsScreen() {
  const { state, reload, upsert } = useContacts()

  return (
    <section aria-labelledby="contacts-heading">
      <div className="alert alert--warn" role="note">
        <p>
          <strong>Лише синтетичні тестові дані.</strong> Не вводьте справжні імена чи контакти
          людей.
        </p>
      </div>

      <h2 id="contacts-heading">Мої контакти</h2>
      <p className="form__aside">Контакти бачите лише ви.</p>

      {state.status === 'loading' && <p className="status status--pending">Завантажую контакти…</p>}

      {state.status === 'error' && (
        <div>
          <FormStatus error={new Error(state.message)} />
          <button type="button" onClick={reload}>
            Спробувати ще раз
          </button>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <CreateContactForm onCreated={upsert} />
          {state.contacts.length === 0 ? (
            <p className="empty">Контактів поки немає.</p>
          ) : (
            <ul className="books">
              {state.contacts.map((contact) => (
                <ContactRow key={contact.id} contact={contact} onChanged={upsert} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function CreateContactForm({ onCreated }: { onCreated: (contact: ExternalBorrower) => void }) {
  const [alias, setAlias] = useState('')
  const [informed, setInformed] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFailure(undefined)
    setNotice(undefined)

    const result = validate(createExternalBorrowerRequestSchema, {
      alias,
      ownerInformed: informed,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setPending(true)

    try {
      const { contact } = await createContact(result.data)

      onCreated(contact)
      setAlias('')
      setInformed(false)
      setNotice('Контакт додано.')
    } catch (error) {
      setFailure(toError(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(event) => {
        void submit(event)
      }}
    >
      <FormStatus error={failure} success={notice} />
      <TextField
        id="contact-alias"
        label="Аліас"
        autoComplete="off"
        value={alias}
        error={errors.alias}
        onChange={(event) => {
          setAlias(event.target.value)
        }}
      />
      <div className="field field--checkbox">
        <input
          id="contact-owner-informed"
          type="checkbox"
          checked={informed}
          aria-invalid={errors.ownerInformed === undefined ? undefined : true}
          onChange={(event) => {
            setInformed(event.target.checked)
          }}
        />
        <label htmlFor="contact-owner-informed">Я повідомив(-ла) людину</label>
      </div>
      <p className="field__hint">
        Це ваша заява як власника. Вона не є підтвердженням з боку самої людини.
      </p>
      {errors.ownerInformed !== undefined && (
        <p className="field__error" role="alert">
          {errors.ownerInformed}
        </p>
      )}
      <button type="submit" disabled={pending}>
        Додати контакт
      </button>
    </form>
  )
}

function ContactRow({
  contact,
  onChanged,
}: {
  contact: ExternalBorrower
  onChanged: (contact: ExternalBorrower) => void
}) {
  const [editing, setEditing] = useState(false)
  const [alias, setAlias] = useState(contact.alias)
  const [error, setError] = useState<string>()
  const [failure, setFailure] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(false)

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFailure(undefined)
    setNotice(undefined)

    const result = validate(updateExternalBorrowerRequestSchema, { alias })

    if (!result.ok) {
      setError(result.errors.alias)
      return
    }

    setError(undefined)
    setPending(true)

    try {
      const { contact: updated } = await renameContact(contact.id, result.data)

      onChanged(updated)
      setEditing(false)
      setNotice('Аліас змінено.')
    } catch (caught) {
      setFailure(toError(caught))
    } finally {
      setPending(false)
    }
  }

  if (!editing) {
    return (
      <li className="book">
        <span className="book__title">{contact.alias}</span>
        <button
          type="button"
          className="button--ghost"
          onClick={() => {
            setAlias(contact.alias)
            setNotice(undefined)
            setEditing(true)
          }}
        >
          Змінити аліас
        </button>
        {notice !== undefined && <FormStatus success={notice} />}
      </li>
    )
  }

  return (
    <li className="book">
      <form
        className="form"
        noValidate
        onSubmit={(event) => {
          void save(event)
        }}
      >
        <FormStatus error={failure} />
        <TextField
          id={`contact-alias-${contact.id}`}
          label="Новий аліас"
          autoComplete="off"
          value={alias}
          error={error}
          onChange={(event) => {
            setAlias(event.target.value)
          }}
        />
        <button type="submit" disabled={pending}>
          Зберегти
        </button>{' '}
        <button
          type="button"
          className="button--ghost"
          onClick={() => {
            setEditing(false)
            setFailure(undefined)
            setError(undefined)
          }}
        >
          Скасувати
        </button>
      </form>
    </li>
  )
}
