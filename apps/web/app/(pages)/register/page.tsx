'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { PASSWORD_LIMITS, registerRequestSchema, sessionResponseSchema } from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../lib/api'
import { useSession } from '../../lib/use-session'
import { validate, type FieldErrors } from '../../lib/validation'

export default function RegisterPage() {
  const router = useRouter()
  const session = useSession()
  const [fields, setFields] = useState({ displayName: '', email: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>()
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFailure(undefined)

    const result = validate(registerRequestSchema, fields)

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setPending(true)

    try {
      const { user } = await apiRequest('/auth/register', {
        method: 'POST',
        body: result.data,
        schema: sessionResponseSchema,
      })

      // Shared session (§8e-3 follow-up) — same reasoning as LoginPage:
      // every other mounted consumer (`NavBar` included) sees the new
      // identity through the same context, without a fetch of its own.
      session.setUser(user)
      router.push('/profile')
    } catch (error) {
      // Зайнята адреса — це помилка конкретного поля, а не форми загалом.
      if (error instanceof ApiRequestError && error.code === 'EMAIL_TAKEN') {
        setErrors({ email: error.message })
      } else {
        setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="page page--narrow">
      <h1>Реєстрація</h1>
      <p className="lede">Акаунт потрібен, щоб вести свою полицю й бачити бібліотеки друзів.</p>

      <FormStatus error={failure} />

      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          id="displayName"
          label="Імʼя"
          name="displayName"
          autoComplete="name"
          required
          value={fields.displayName}
          error={errors.displayName}
          onChange={(event) => {
            setFields({ ...fields, displayName: event.target.value })
          }}
        />

        <TextField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={fields.email}
          error={errors.email}
          onChange={(event) => {
            setFields({ ...fields, email: event.target.value })
          }}
        />

        <TextField
          id="password"
          label="Пароль"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          hint={`Щонайменше ${String(PASSWORD_LIMITS.min)} символів. Довжина важливіша за спецсимволи.`}
          value={fields.password}
          error={errors.password}
          onChange={(event) => {
            setFields({ ...fields, password: event.target.value })
          }}
        />

        <button type="submit" disabled={pending}>
          {pending ? 'Створюю акаунт…' : 'Створити акаунт'}
        </button>
      </form>

      <p className="form__aside">
        Уже маєте акаунт? <Link href="/login">Увійти</Link>
      </p>
    </main>
  )
}
