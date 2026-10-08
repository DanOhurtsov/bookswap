'use client'

import Link from 'next/link'
import { useState } from 'react'
import { createRecordedLoanRequestSchema, loanResponseSchema } from '@bookswap/shared'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { useFriends } from '@/app/lib/use-friends'
import { validate, type FieldErrors } from '@/app/lib/validation'

interface RecordExistingLoanFormProps {
  copyId: string
  /** Запис створено: батько перечитує полицю. */
  onRecorded: () => Promise<void>
  onCancel: () => void
}

/** Сьогоднішня дата UTC — та сама, що рахує сервер, тож `max` не розходиться з перевіркою. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10)

/**
 * Stage 10 (10e, D6): власник записує книжку, яку вже віддав другові до реєстрації в BookSwap.
 *
 * Це запис **власника**, а не запит: друг мусить підтвердити отримання. Форма чесно про це попереджає, бо
 * до відповіді книжка недоступна іншим. Обмеження (дата не в майбутньому, строк не раніше передачі) —
 * ті самі, що на сервері, який лишається джерелом правди.
 */
export function RecordExistingLoanForm({
  copyId,
  onRecorded,
  onCancel,
}: RecordExistingLoanFormProps) {
  const { state } = useFriends()
  const [borrowerId, setBorrowerId] = useState('')
  const [handedAt, setHandedAt] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>()
  const [pending, setPending] = useState(false)

  async function submit(): Promise<void> {
    const result = validate(createRecordedLoanRequestSchema, {
      copyId,
      borrowerId,
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
      await apiRequest('/loans/recorded', {
        method: 'POST',
        body: result.data,
        schema: loanResponseSchema,
      })
      await onRecorded()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      setPending(false)
    }
  }

  if (state.status === 'loading')
    return <p className="status status--pending">Завантажую друзів…</p>

  if (state.status === 'error') {
    return (
      <>
        <FormStatus error={new Error(state.message)} />
        <CancelButton onCancel={onCancel} />
      </>
    )
  }

  if (state.friends.length === 0) {
    return (
      <>
        <p className="empty">
          Записати передачу можна лише другові, який є в BookSwap. Спершу{' '}
          <Link href="/friends">додайте друга</Link>.
        </p>
        <CancelButton onCancel={onCancel} />
      </>
    )
  }

  return (
    <div className="form">
      <p className="form__aside">
        Це запис про книжку, яку ви вже віддали. Друг побачить його й має підтвердити, що отримав
        книжку, — або відхилити. До його відповіді книжка недоступна іншим, а ви можете виправити
        дати чи відкликати запис.
      </p>

      <SelectField
        id={`record-friend-${copyId}`}
        label="Кому віддали"
        value={borrowerId}
        error={errors.borrowerId}
        onChange={(event) => {
          setBorrowerId(event.target.value)
        }}
      >
        <option value="">— оберіть друга —</option>
        {state.friends.map((friend) => (
          <option key={friend.user.id} value={friend.user.id}>
            {friend.user.displayName}
          </option>
        ))}
      </SelectField>

      <TextField
        id={`record-handed-${copyId}`}
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
        id={`record-due-${copyId}`}
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
          {pending ? 'Записую…' : 'Записати передачу'}
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
