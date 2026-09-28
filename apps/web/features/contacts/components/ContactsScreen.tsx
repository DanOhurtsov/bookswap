'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import {
  GUEST_INVITATION_EMAIL_DOMAIN,
  createExternalBorrowerInvitationRequestSchema,
  createExternalBorrowerRequestSchema,
  updateExternalBorrowerRequestSchema,
  type ExternalBorrower,
} from '@bookswap/shared'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { validate } from '@/app/lib/validation'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import {
  createContact,
  deleteContact,
  renameContact,
  sendContactInvitation,
} from '../api/contacts-requests'
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
  const { state, reload, upsert, remove } = useContacts()

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
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  onChanged={upsert}
                  onDeleted={remove}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <p className="form__aside">
        <Link href="/loans/guest">Гостьові позики</Link> ·{' '}
        <Link href="/library">Моя бібліотека</Link> · <Link href="/">На головну</Link>
      </p>
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
  onDeleted,
}: {
  contact: ExternalBorrower
  onChanged: (contact: ExternalBorrower) => void
  onDeleted: (contactId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [alias, setAlias] = useState(contact.alias)
  const [error, setError] = useState<string>()
  const [failure, setFailure] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<unknown>()
  const [deleting, setDeleting] = useState(false)

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

  /**
   * Item 3 (10f.3 web-рев'ю): сервер сам відмовляє (409) з ясним поясненням — «активна позика» чи
   * «незакрита втрата» (Q3d). Фронт не вгадує причину, лише показує повідомлення сервера й лишає
   * контакт у списку; лише 204 прибирає рядок.
   */
  async function remove(): Promise<void> {
    setDeleteFailure(undefined)
    setDeleting(true)

    try {
      await deleteContact(contact.id)
      onDeleted(contact.id)
    } catch (caught) {
      setDeleteFailure(toError(caught))
    } finally {
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  if (!editing) {
    return (
      <li className="book">
        <span className="book__title">{contact.alias}</span>
        <div className="person__actions">
          <button
            type="button"
            className="button--ghost"
            disabled={deleting}
            onClick={() => {
              setAlias(contact.alias)
              setNotice(undefined)
              setEditing(true)
            }}
          >
            Змінити аліас
          </button>
          <button
            type="button"
            className="button--danger"
            disabled={deleting}
            onClick={() => {
              setConfirmingDelete(true)
            }}
          >
            {deleting ? 'Видаляю…' : 'Видалити'}
          </button>
        </div>
        {notice !== undefined && <FormStatus success={notice} />}
        <FormStatus error={deleteFailure} />
        <InviteContactForm contactId={contact.id} />
        <ConfirmDialog
          open={confirmingDelete}
          title="Видалити контакт?"
          description="Видалити можна лише за відсутності активної гостьової позики й незакритої втрати. Факт минулих позик і дати лишаться в історії — зникне лише псевдонім."
          confirmLabel="Видалити"
          pending={deleting}
          onConfirm={() => {
            void remove()
          }}
          onCancel={() => {
            setConfirmingDelete(false)
          }}
        />
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

/**
 * Stage 10 (10g, D2): запрошення гостя поштою. `pending` disables the submit button —
 * a second click mid-flight cannot fire a second request. Q4/UI: the address itself is
 * cleared from this component's own state as soon as the request settles (success or
 * error alike), never written to the URL or to browser storage — nothing here outlives
 * the request that needed it.
 */
function InviteContactForm({ contactId }: { contactId: string }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string>()
  const [failure, setFailure] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (pending) return

    setFailure(undefined)
    setNotice(undefined)

    const result = validate(createExternalBorrowerInvitationRequestSchema, { email })

    if (!result.ok) {
      setError(result.errors.email)
      return
    }

    setError(undefined)
    setPending(true)

    try {
      await sendContactInvitation(contactId, result.data)
      setNotice(
        'Створено тестове запрошення. Лист нікуди не відправлено — це синтетичний ' +
          'транспорт; посилання можна знайти в dev-логу API.',
      )
    } catch (caught) {
      setFailure(toError(caught))
    } finally {
      setEmail('')
      setPending(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="button--ghost"
        onClick={() => {
          setOpen(true)
        }}
      >
        Запросити гостя
      </button>
    )
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
        id={`contact-invite-email-${contactId}`}
        label="Email гостя"
        type="email"
        autoComplete="off"
        hint={`Лише синтетичні адреси домену ${GUEST_INVITATION_EMAIL_DOMAIN} — тестове середовище, реальні контакти заборонені.`}
        value={email}
        error={error}
        onChange={(event) => {
          setEmail(event.target.value)
        }}
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Надсилаю…' : 'Надіслати запрошення'}
      </button>{' '}
      <button
        type="button"
        className="button--ghost"
        disabled={pending}
        onClick={() => {
          setOpen(false)
          setEmail('')
          setError(undefined)
          setFailure(undefined)
          setNotice(undefined)
        }}
      >
        Сховати
      </button>
    </form>
  )
}
