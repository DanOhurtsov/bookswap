'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GUEST_INVITATION_EMAIL_DOMAIN,
  GUEST_RESPONSE_LIMITS,
  guestInvitationEmailSchema,
  guestResponseNicknameSchema,
  type GuestResponseAnswer,
  type ResolveGuestResponseResponse,
} from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import { ApiRequestError, describeError } from '@/app/lib/api'
import { formatDateTime } from '@/app/lib/labels'
import { toFieldErrors, type FieldErrors } from '@/app/lib/validation'
import {
  answerGuestLoan,
  requestGuestCode,
  resolveGuestLink,
  verifyGuestCode,
} from '../api/guest-confirmation-requests'
import { guestTokenFromHash } from '../model/guest-link-token'

/** Що бачить гість замість потоку, коли посилання не веде до відповіді. */
type Terminal = 'no-token' | 'unavailable' | 'invalid' | 'expired' | 'mismatch'

type Step =
  | { kind: 'details' }
  | { kind: 'code' }
  | { kind: 'answer'; proof: string }
  | { kind: 'done'; answer: GuestResponseAnswer }

type Phase =
  | { kind: 'init' }
  | { kind: 'terminal'; reason: Terminal }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; resolved: ResolveGuestResponseResponse; step: Step }

const TERMINAL_TEXT: Record<Terminal, { title: string; text: string }> = {
  'no-token': {
    title: 'У адресі немає посилання',
    text: 'Відкрийте посилання, яке вам передав власник книжки, ще раз.',
  },
  // Функція вимкнена на сервері: жодного кроку потоку не показуємо — сторінка виглядає як невідома.
  unavailable: { title: 'Сторінку не знайдено', text: '' },
  invalid: {
    title: 'Посилання недійсне',
    text: 'Воно не існує, уже використане або замінене новим. Попросіть власника книжки видати нове посилання.',
  },
  expired: {
    title: 'Строк дії посилання минув',
    text: 'Відповісти вже не можна. Попросіть власника книжки видати нове посилання.',
  },
  mismatch: {
    title: 'Стан позики змінився',
    text: 'Відповідь не записано. Зверніться до власника книжки.',
  },
}

/** Помилка API → кінцевий стан сторінки (або `undefined` — показати як звичайну помилку кроку). */
function terminalFor(error: unknown): Terminal | undefined {
  if (!(error instanceof ApiRequestError)) return undefined

  switch (error.code) {
    case 'FEATURE_DISABLED':
      return 'unavailable'
    case 'GUEST_LINK_INVALID':
      return 'invalid'
    case 'GUEST_LINK_EXPIRED':
      return 'expired'
    case 'LOAN_COPY_STATE_MISMATCH':
      return 'mismatch'
    default:
      return undefined
  }
}

function stepMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'GUEST_CODE_INVALID') {
      return 'Код хибний, прострочений або вже використаний. Перевірте його або надішліть новий.'
    }

    if (error.code === 'GUEST_CODE_RATE_LIMITED' || error.status === 429) {
      return 'Забагато спроб. Зачекайте або попросіть власника книжки видати нове посилання.'
    }

    if (error.code === 'GUEST_PROOF_INVALID') {
      return 'Підтвердження email застаріло. Підтвердіть адресу кодом ще раз.'
    }
  }

  return describeError(error)
}

/**
 * Stage 10 (10i.3): публічна сторінка `/guest-loan-confirmation#<токен>` — гість без акаунта відповідає на
 * запит підтвердження конкретної позики.
 *
 * Токен читається з фрагмента, одразу прибирається з адресного рядка й тримається ЛИШЕ в пам'яті (ref).
 * До підтвердження email показується тільки назва книжки, автори й строк дії посилання — без дати передачі,
 * приватного псевдоніма власника, контакту, історії й email власника (їх немає й у відповіді API). Гість вводить нікнейм і БУДЬ-ЯКИЙ
 * свій email (синтетичний, D2), підтверджує його шестизначним кодом і один раз відповідає. Адреса доставки
 * листа власника тут невідома й ніде не порівнюється; окремого схвалення власником немає (Q28).
 * Формулювання доказу: відповідь через посилання після підтвердження контролю введеного email — не доведена
 * особа первісного адресата (§0.12 п. 4).
 */
export function GuestLoanResponse() {
  const tokenRef = useRef<string>(undefined)
  const started = useRef(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'init' })

  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string>()
  const [pending, setPending] = useState(false)

  /**
   * `resolve` за токеном. Виклик — і з ефекту, і з «Спробувати ще раз»: токен береться з пам'яті
   * компонента (`tokenRef`), у URL, сховища чи лог він не повертається. setState — лише в колбеках.
   */
  const resolve = useCallback((token: string | undefined): void => {
    // Без токена запиту немає: результат — `undefined`.
    const resolving = token === undefined ? Promise.resolve(undefined) : resolveGuestLink(token)

    resolving
      .then((resolved) => {
        setPhase(
          resolved === undefined
            ? { kind: 'terminal', reason: 'no-token' }
            : { kind: 'ready', resolved, step: { kind: 'details' } },
        )
      })
      .catch((error: unknown) => {
        const reason = terminalFor(error)

        setPhase(
          reason === undefined
            ? { kind: 'error', message: describeError(error) }
            : { kind: 'terminal', reason },
        )
      })
  }, [])

  useEffect(() => {
    // Ефект може виконатися двічі (StrictMode): друге виконання вже не побачить фрагмента.
    if (started.current) return

    started.current = true

    const token = guestTokenFromHash(window.location.hash)

    // Токен більше не має лишатися в адресному рядку, історії й закладках.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)

    tokenRef.current = token
    resolve(token)
  }, [resolve])

  /** Лише для тимчасової помилки початкового `resolve`; термінальні стани повтору не мають. */
  function retryResolve(): void {
    setPhase({ kind: 'init' })
    resolve(tokenRef.current)
  }

  const token = (): string => tokenRef.current ?? ''

  function setStep(step: Step): void {
    setPhase((current) => (current.kind === 'ready' ? { ...current, step } : current))
  }

  /** Спільна обробка помилки кроку: кінцеві стани — на всю сторінку, решта — повідомлення кроку. */
  function fail(error: unknown, onStepError?: () => void): void {
    const reason = terminalFor(error)

    if (reason !== undefined) {
      tokenRef.current = undefined
      setPhase({ kind: 'terminal', reason })
      return
    }

    onStepError?.()
    setFailure(stepMessage(error))
  }

  function validateDetails(): { nickname: string; email: string } | undefined {
    const nick = guestResponseNicknameSchema.safeParse(nickname)
    const mail = guestInvitationEmailSchema.safeParse(email)
    const next: FieldErrors = {}

    if (!nick.success) Object.assign(next, { nickname: toFieldErrors(nick.error).form })
    if (!mail.success) Object.assign(next, { email: toFieldErrors(mail.error).form })

    setErrors(next)

    return nick.success && mail.success ? { nickname: nick.data, email: mail.data } : undefined
  }

  async function sendCode(): Promise<void> {
    const values = validateDetails()

    if (values === undefined) return

    setFailure(undefined)
    setPending(true)

    try {
      await requestGuestCode({ token: token(), ...values })
      setCode('')
      setStep({ kind: 'code' })
    } catch (error) {
      fail(error)
    } finally {
      setPending(false)
    }
  }

  async function verify(): Promise<void> {
    const values = validateDetails()

    if (values === undefined) return

    if (!/^\d{6}$/.test(code)) {
      setErrors({ code: 'Код — шість цифр' })
      return
    }

    setErrors({})
    setFailure(undefined)
    setPending(true)

    try {
      const verified = await verifyGuestCode({ token: token(), ...values, code })

      setStep({ kind: 'answer', proof: verified.proof })
    } catch (error) {
      fail(error)
    } finally {
      setPending(false)
    }
  }

  async function answer(proof: string, choice: GuestResponseAnswer): Promise<void> {
    const values = validateDetails()

    if (values === undefined) return

    setFailure(undefined)
    setPending(true)

    try {
      await answerGuestLoan({ token: token(), ...values, proof, answer: choice })

      // Відповідь одноразова: усе, що було потрібне для неї, більше не тримаємо.
      tokenRef.current = undefined
      setCode('')
      setStep({ kind: 'done', answer: choice })
    } catch (error) {
      // Доказ застарів — потрібен новий код; сам потік лишається на кроці коду.
      fail(error, () => {
        setStep({ kind: 'code' })
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="page page--narrow">
      <h1>Підтвердження отримання книжки</h1>
      {renderPhase()}
    </main>
  )

  function renderPhase() {
    switch (phase.kind) {
      case 'init':
        return <p className="status status--pending">Перевіряю посилання…</p>
      case 'error':
        return (
          <div>
            <p className="status status--error" role="alert">
              {phase.message}
            </p>
            <div className="person__actions">
              <button type="button" onClick={retryResolve}>
                Спробувати ще раз
              </button>
            </div>
          </div>
        )
      case 'terminal':
        return phase.reason === 'unavailable' ? (
          <p className="empty">Сторінку не знайдено.</p>
        ) : (
          <div role="status">
            <h2>{TERMINAL_TEXT[phase.reason].title}</h2>
            <p>{TERMINAL_TEXT[phase.reason].text}</p>
          </div>
        )
      case 'ready':
        return renderReady(phase.resolved, phase.step)
    }
  }

  function renderReady(resolved: ResolveGuestResponseResponse, step: Step) {
    const { title, authors } = resolved.book

    if (step.kind === 'done') {
      return (
        <div role="status">
          <h2>Відповідь записано</h2>
          <p>
            {step.answer === 'RECEIVED'
              ? `Ви підтвердили, що отримали «${title}».`
              : `Ви повідомили, що не отримували «${title}». Власник побачить розбіжність і розв’яже її сам.`}
          </p>
          <p className="form__aside">
            Відповідь можна дати лише один раз, тож посилання більше не працює. Це відповідь через
            посилання після підтвердження контролю вказаної вами адреси. Сторінку можна закрити.
          </p>
        </div>
      )
    }

    // Після коду поля зафіксовані: відповідь прив'язана саме до цієї адреси й нікнейма.
    const locked = step.kind !== 'details'

    return (
      <>
        <div className="alert alert--warn" role="note">
          <p>
            <strong>Лише синтетичні тестові дані.</strong> Не вводьте справжні імена чи адреси.
          </p>
        </div>

        <section aria-label="Книжка">
          <p>Власник просить підтвердити, що ви отримали цю книжку:</p>
          <p className="book__title">{title}</p>
          {authors.length > 0 && <p className="book__meta">{authors.join(', ')}</p>}
          <p className="book__meta">Посилання діє до {formatDateTime(resolved.expiresAt)}.</p>
        </section>

        <p className="form__aside">
          Акаунт не потрібен. Вкажіть нікнейм і будь-яку свою адресу пошти, підтвердьте її кодом і
          оберіть відповідь. Адреса не обов’язково має збігатися з тією, на яку надсилали лист із
          посиланням (якщо надсилали). Посилання можна передати іншій людині, тож відповідь означає
          лише: її дали через це посилання після підтвердження контролю введеної адреси.
        </p>

        <div className="form">
          <TextField
            id="guest-nickname"
            label="Нікнейм"
            maxLength={GUEST_RESPONSE_LIMITS.nicknameMax}
            autoComplete="off"
            value={nickname}
            disabled={locked || pending}
            error={errors.nickname}
            onChange={(event) => {
              setNickname(event.target.value)
            }}
          />
          <TextField
            id="guest-email"
            label="Ваша адреса пошти"
            type="email"
            autoComplete="off"
            placeholder={`name@${GUEST_INVITATION_EMAIL_DOMAIN}`}
            hint={`Тільки синтетичний домен ${GUEST_INVITATION_EMAIL_DOMAIN}.`}
            value={email}
            disabled={locked || pending}
            error={errors.email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          />

          {failure !== undefined && (
            <div className="alert alert--error" role="alert">
              <p>{failure}</p>
            </div>
          )}

          {step.kind === 'details' && (
            <div className="person__actions">
              <button type="button" disabled={pending} onClick={() => void sendCode()}>
                {pending ? 'Надсилаю…' : 'Надіслати код'}
              </button>
            </div>
          )}

          {step.kind === 'code' && (
            <>
              <p className="form__aside">
                Тестовий режим: лист із кодом нікуди назовні не надсилається, тож реальна пошта його
                не отримає. Код дійсний недовго й спрацьовує один раз.
              </p>
              <TextField
                id="guest-code"
                label="Код із листа"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={GUEST_RESPONSE_LIMITS.codeLength}
                value={code}
                disabled={pending}
                error={errors.code}
                onChange={(event) => {
                  setCode(event.target.value.trim())
                }}
              />
              <div className="person__actions">
                <button type="button" disabled={pending} onClick={() => void verify()}>
                  {pending ? 'Перевіряю…' : 'Підтвердити код'}
                </button>
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => void sendCode()}
                >
                  Надіслати код ще раз
                </button>
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => {
                    setFailure(undefined)
                    setCode('')
                    setStep({ kind: 'details' })
                  }}
                >
                  Змінити адресу чи нікнейм
                </button>
              </div>
            </>
          )}

          {step.kind === 'answer' && (
            <>
              <p className="status status--ok" role="status">
                Адресу підтверджено. Оберіть відповідь — її можна дати лише один раз.
              </p>
              <div className="person__actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void answer(step.proof, 'RECEIVED')}
                >
                  Отримав книжку
                </button>
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => void answer(step.proof, 'DENIED')}
                >
                  Не отримував
                </button>
              </div>
            </>
          )}
        </div>
      </>
    )
  }
}
