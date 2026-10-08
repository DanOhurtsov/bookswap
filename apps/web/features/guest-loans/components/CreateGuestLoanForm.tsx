'use client'

import Link from 'next/link'
import { useState } from 'react'
import { createGuestLoanRequestSchema } from '@bookswap/shared'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { validate, type FieldErrors } from '@/app/lib/validation'
import { useContacts } from '@/features/contacts/index.client'
import { createGuestConfirmation } from '../api/guest-confirmation-requests'
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
  /** Створений запит підтвердження: форма лишається, щоб вести власника до видачі посилання. */
  const [requestedId, setRequestedId] = useState<string>()

  async function submit(mode: 'manual' | 'confirmation'): Promise<void> {
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
      if (mode === 'manual') {
        await createGuestLoan(result.data)
        await onCreated()
      } else {
        const created = await createGuestConfirmation(result.data)

        setRequestedId(created.confirmation.id)
        setPending(false)
      }
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

  if (requestedId !== undefined) {
    return (
      <div className="form">
        <div className="alert alert--ok" role="status">
          <p>
            Запит підтвердження створено. Отримання гостем <strong>ще не підтверджене</strong>, а
            примірник недоступний для нових позик. Далі видайте гостю посилання.
          </p>
        </div>
        <div className="person__actions">
          <Link href={`/loans/guest?confirmationId=${encodeURIComponent(requestedId)}`}>
            Видати посилання гостю
          </Link>
          <button
            type="button"
            className="button--ghost"
            onClick={() => {
              void onCreated()
            }}
          >
            Закрити
          </button>
        </div>
      </div>
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
        Це позика людині без акаунта BookSwap. Можна записати її одразу — тоді вона позначиться як
        передана <strong>зі слів власника</strong> (гість її не підтверджує). Або записати й
        попросити гостя підтвердити отримання за посиланням: до його відповіді книжка недоступна для
        нових позик, а отримання не вважається підтвердженим. Друзям і стороннім цей факт завжди
        видно анонімно.
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
        <button type="button" disabled={pending} onClick={() => void submit('manual')}>
          {pending ? 'Записую…' : 'Записати гостьову позику'}
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={pending}
          onClick={() => void submit('confirmation')}
        >
          Записати й попросити підтвердження гостя
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
