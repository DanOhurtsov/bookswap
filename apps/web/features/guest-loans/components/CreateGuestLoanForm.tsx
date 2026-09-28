'use client'

import Link from 'next/link'
import { useState } from 'react'
import { createGuestLoanRequestSchema } from '@bookswap/shared'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { validate, type FieldErrors } from '@/app/lib/validation'
import { useContacts } from '@/features/contacts/index.client'
import { createGuestLoan } from '../api/guest-loans-requests'

interface CreateGuestLoanFormProps {
  copyId: string
  /** Позику створено: батько перечитує полицю/список. */
  onCreated: () => Promise<void>
  onCancel: () => void
}

/** Сьогоднішня дата UTC — та сама, що рахує сервер, тож `max` не розходиться з перевіркою. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10)

/**
 * Stage 10 (10f.3): власник записує книжку, віддану людині без акаунта BookSwap.
 *
 * Дзеркалить `RecordExistingLoanForm` (10e), лише замість друга — приватний контакт
 * (`ExternalBorrower`), а підтвердження від другої сторони не буде взагалі: гість не має акаунта,
 * тож книжка одразу `HANDED_OVER`. D2 лишається відкритим release blocker — банер про синтетичні
 * дані показується тут, а не лише на сторінці контактів, бо саме тут вводиться дата фактичної
 * передачі разом із чужим (навіть якщо приватним) псевдонімом.
 */
export function CreateGuestLoanForm({ copyId, onCreated, onCancel }: CreateGuestLoanFormProps) {
  const { state } = useContacts()
  const [externalBorrowerId, setExternalBorrowerId] = useState('')
  const [handedAt, setHandedAt] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>()
  const [pending, setPending] = useState(false)

  async function submit(): Promise<void> {
    const result = validate(createGuestLoanRequestSchema, {
      copyId,
      externalBorrowerId,
      handedAt,
      ...(dueAt === '' ? {} : { dueAt }),
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setFailure(undefined)
    setPending(true)

    try {
      await createGuestLoan(result.data)
      await onCreated()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      setPending(false)
    }
  }

  if (state.status === 'loading')
    return <p className="status status--pending">Завантажую контакти…</p>

  if (state.status === 'error') {
    return (
      <>
        <FormStatus error={new Error(state.message)} />
        <CancelButton onCancel={onCancel} />
      </>
    )
  }

  if (state.contacts.length === 0) {
    return (
      <>
        <p className="empty">
          Позичити гостю можна лише за наявним контактом. Спершу{' '}
          <Link href="/contacts">додайте контакт</Link>.
        </p>
        <CancelButton onCancel={onCancel} />
      </>
    )
  }

  return (
    <div className="form">
      <div className="alert alert--warn" role="note">
        <p>
          <strong>Лише синтетичні тестові дані.</strong> Не вводьте справжні імена чи контакти
          людей.
        </p>
      </div>

      <p className="form__aside">
        Це позика людині без акаунта BookSwap: підтвердження від неї не буде, книжка одразу
        позначиться як передана. Друзям і стороннім цей факт завжди видно анонімно.
      </p>

      <SelectField
        id={`guest-contact-${copyId}`}
        label="Кому віддали"
        value={externalBorrowerId}
        error={errors.externalBorrowerId}
        onChange={(event) => {
          setExternalBorrowerId(event.target.value)
        }}
      >
        <option value="">— оберіть контакт —</option>
        {state.contacts.map((contact) => (
          <option key={contact.id} value={contact.id}>
            {contact.alias}
          </option>
        ))}
      </SelectField>

      <TextField
        id={`guest-handed-${copyId}`}
        label="Коли віддали"
        type="date"
        max={todayUtc()}
        hint="Фактична дата передачі, не в майбутньому."
        value={handedAt}
        error={errors.handedAt}
        onChange={(event) => {
          setHandedAt(event.target.value)
        }}
      />

      <TextField
        id={`guest-due-${copyId}`}
        label="Повернути до"
        type="date"
        min={handedAt === '' ? undefined : handedAt}
        hint="Необов’язково. Не раніше дати передачі."
        value={dueAt}
        error={errors.dueAt}
        onChange={(event) => {
          setDueAt(event.target.value)
        }}
      />

      <FormStatus error={failure} />

      <div className="person__actions">
        <button type="button" disabled={pending} onClick={() => void submit()}>
          {pending ? 'Записую…' : 'Записати гостьову позику'}
        </button>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  )
}

function CancelButton({
  onCancel,
  disabled = false,
}: {
  onCancel: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" className="button--ghost" disabled={disabled} onClick={onCancel}>
      Скасувати
    </button>
  )
}
