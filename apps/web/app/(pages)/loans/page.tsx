'use client'

import Link from 'next/link'
import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type ReactNode } from 'react'
import {
  LOAN_ROLES,
  LOAN_STATUS,
  type Loan,
  type LoanAction,
  type LoanRole,
  type Me,
} from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LostLoanRecovery } from '@/components/LostLoanRecovery'
import { RecordedLoanActions } from '@/components/RecordedLoanActions'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../lib/api'
import {
  CONDITION_LABELS,
  LOAN_ACTION_LABELS,
  LOAN_STATUS_LABELS,
  formatDate,
} from '../../lib/labels'
import { counterpartOf, roleOf, useLoan, useLoans } from '../../lib/use-loans'
import { useSession } from '../../lib/use-session'

/**
 * §5 і §8: усі позичання людини, з обох боків.
 *
 * Набір кнопок виводиться з ролі й статусу **вичерпним** `switch` без `default`.
 * Це не стилістика: коли в §5.1 колись додасться рядок, збірка зламається тут, а
 * не мовчки покаже картку без дій. Рішення «чи можна» все одно ухвалює сервер —
 * кнопки лише не пропонують того, що гарантовано дасть 409.
 */
export default function LoansPage() {
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  // `useSearchParams` вимагає межі Suspense: без неї Next не вміє пререндерити
  // сторінку, яка залежить від рядка запиту.
  return (
    <Suspense
      fallback={
        <Shell>
          <p className="status status--pending">Завантажую…</p>
        </Shell>
      }
    >
      <LoansScreen user={session.user} />
    </Suspense>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Позичання</h1>
      {children}
    </main>
  )
}

const ROLE_LABELS: Readonly<Record<LoanRole, string>> = {
  owner: 'Мої книжки',
  borrower: 'Я позичаю',
}

/**
 * Спільна механіка дій над лоаном.
 *
 * Обидва режими сторінки — список і одне позичання — роблять із карткою те саме,
 * і різняться лише тим, звідки взялися дані. Тримати два комплекти `busyKey`,
 * `failure` й `ConfirmDialog` означало б, що одного дня вони розійдуться.
 */
function useLoanActions(reload: () => Promise<void>) {
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      // Саме `await`: без нього `busyKey` знімався б до приходу нових даних, і
      // ту саму дію можна було б натиснути вдруге по вже застарілій картці.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
      setConfirmation(undefined)
    }
  }

  const act = (loan: Loan, action: LoanAction, body: Record<string, unknown> = {}): Promise<void> =>
    run(`${action}:${loan.id}`, async () => {
      await apiRequest(`/loans/${loan.id}`, { method: 'PATCH', body: { action, ...body } })
    })

  return { failure, busyKey, confirmation, setConfirmation, act }
}

type LoanActions = ReturnType<typeof useLoanActions>

/**
 * Розвилка режимів.
 *
 * Два окремі компоненти, а не один із умовним хуком: `useLoan` і `useLoans`
 * мусять викликатися безумовно, і спроба обійти це «порожнім шляхом» означала б
 * зайвий запит або хук, який іноді нічого не робить.
 */
/** `?role=` — підказка інтерфейсу, не право. Невідоме значення тихо стає `owner`. */
function readRole(parameters: URLSearchParams | ReadonlyURLSearchParams): LoanRole | undefined {
  return LOAN_ROLES.find((value) => value === parameters.get('role'))
}

function LoansScreen({ user }: { user: Me }) {
  const parameters = useSearchParams()
  // Глибоке посилання: `?loanId=…` відкриває один конкретний лоан, а `?role=…`
  // лише задає вкладку списку. Роль **не** визначає прав — їх дає сервер за
  // `owner`/`borrower` самого лоану.
  const loanId = parameters.get('loanId')

  return loanId === null ? (
    <LoanListView user={user} />
  ) : (
    <SingleLoanView user={user} loanId={loanId} />
  )
}

function LoanListView({ user }: { user: Me }) {
  const router = useRouter()
  const parameters = useSearchParams()
  const [statusFilter, setStatusFilter] = useState('')

  /**
   * Вкладка живе в URL, а не в `useState`.
   *
   * Інакше вона розходиться з адресою двома способами: зміна `?role=` на тому
   * самому маршруті нічого не робить, а перезавантаження сторінки відкриває не
   * ту вкладку, що в адресному рядку. URL тут і є станом.
   *
   * Перемикання йде через `router.replace`, тобто **запису в історію не
   * створює**: кнопка «назад» повертає на попередню сторінку, а не на попередню
   * вкладку. Це навмисно — вкладка це фільтр, а не крок навігації, і засмічувати
   * ним історію означало б змусити людину тиснути «назад» тричі, щоб піти геть.
   */
  const role = readRole(parameters) ?? 'owner'

  function selectRole(value: LoanRole): void {
    // Решта параметрів зберігається: `?status=` чи будь-що інше, що колись
    // зʼявиться, не має зникати від перемикання вкладки.
    const next = new URLSearchParams(parameters.toString())

    next.set('role', value)
    router.replace(`/loans?${next.toString()}`)
  }

  const status = LOAN_STATUS.find((value) => value === statusFilter)
  const { state, reload } = useLoans({ role, status })
  const actions = useLoanActions(reload)

  return (
    <Shell>
      <nav className="actions" aria-label="Бік позичання">
        {LOAN_ROLES.map((value) => (
          <button
            key={value}
            type="button"
            className={role === value ? undefined : 'button--ghost'}
            aria-pressed={role === value}
            aria-current={role === value ? 'page' : undefined}
            onClick={() => {
              selectRole(value)
            }}
          >
            {ROLE_LABELS[value]}
          </button>
        ))}
      </nav>

      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault()
        }}
        noValidate
      >
        <SelectField
          id="filter-loan-status"
          label="Статус"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value)
          }}
        >
          <option value="">будь-який</option>
          {LOAN_STATUS.map((value) => (
            <option key={value} value={value}>
              {LOAN_STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </form>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.loans.length === 0 && (
        <p className="empty">
          {role === 'owner'
            ? 'Вашими книжками поки ніхто не цікавився. Якщо ви вже віддали книжку другові, запишіть це в бібліотеці.'
            : 'Ви поки нічого не позичали й не просили. Загляньте в бібліотеку друга.'}
        </p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.loans.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              userId={user.id}
              busyKey={actions.busyKey}
              onAct={actions.act}
              onConfirm={actions.setConfirmation}
            />
          ))}
        </ul>
      )}

      <LoanDialog actions={actions} />
      <LoanFooter />
    </Shell>
  )
}

/** §8: `GET /loans/:id`. Чужий лоан API віддає як 404 — сторінка показує помилку. */
function SingleLoanView({ user, loanId }: { user: Me; loanId: string }) {
  const { state, reload } = useLoan(loanId)
  const actions = useLoanActions(reload)

  /**
   * Куди вести кнопкою «Показати всі».
   *
   * Роль береться **виключно з завантаженого лоану** — за тим самим
   * `owner`/`borrower`, яким сервер визначив доступ. `?role=` із рядка запиту
   * сюди не потрапляє взагалі: посилання зі сповіщень несуть лише `loanId`, і
   * запасний `owner` відправляв би позичальника в чужий список.
   *
   * Доки лоан не приїхав, роль невідома — і посилання просто немає. Показати
   * його з вгаданою роллю означало б запропонувати перехід, який половину разів
   * веде не туди.
   */
  const backRole: LoanRole | null =
    state.status === 'ready' ? roleOf(state.data.loan, user.id) : null

  return (
    <Shell>
      <p className="form__aside">
        {backRole === null ? (
          'Одне позичання.'
        ) : (
          <>
            Одне позичання. <Link href={`/loans?role=${backRole}`}>Показати всі</Link>
          </>
        )}
      </p>

      <FormStatus error={actions.failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
      {state.status === 'error' && (
        <>
          <FormStatus error={new Error(state.message)} />
          <p className="empty">Можливо, це позичання вам не належить або його вже немає.</p>
        </>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          <LoanCard
            loan={state.data.loan}
            userId={user.id}
            busyKey={actions.busyKey}
            onAct={actions.act}
            onConfirm={actions.setConfirmation}
          />
        </ul>
      )}

      <LoanDialog actions={actions} />
      <LoanFooter />
    </Shell>
  )
}

function LoanDialog({ actions }: { actions: LoanActions }) {
  const { confirmation, busyKey, setConfirmation } = actions

  return (
    <ConfirmDialog
      open={confirmation !== undefined}
      title={confirmation?.title ?? ''}
      description={confirmation?.description}
      confirmLabel={confirmation?.confirmLabel ?? 'Підтвердити'}
      pending={busyKey !== undefined}
      onConfirm={() => {
        void confirmation?.run()
      }}
      onCancel={() => {
        setConfirmation(undefined)
      }}
    />
  )
}

function LoanFooter() {
  return (
    <p className="form__aside">
      <Link href="/library">Моя бібліотека</Link> · <Link href="/history">Історія</Link> ·{' '}
      <Link href="/notifications">Сповіщення</Link> · <Link href="/friends">Друзі</Link> ·{' '}
      <Link href="/">На головну</Link>
    </p>
  )
}

interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  run: () => Promise<void>
}

function LoanCard({
  loan,
  userId,
  busyKey,
  onAct,
  onConfirm,
}: {
  loan: Loan
  userId: string
  busyKey: string | undefined
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
  onConfirm: (confirmation: Confirmation) => void
}) {
  const isOwner = loan.owner.id === userId
  const counterpart = counterpartOf(loan, userId)

  return (
    <li className="book">
      <Link className="book__title" href={`/works/${loan.work.id}`}>
        {loan.work.title}
      </Link>
      <AuthorLine authors={loan.authors} />
      <EditionLine edition={loan.edition} />

      <span className="book__meta">
        {LOAN_STATUS_LABELS[loan.status]} · {CONDITION_LABELS[loan.copy.condition]} ·{' '}
        {counterpartLine(loan, isOwner)} {counterpart.displayName}
        {loan.dueAt !== null && ` · до ${formatDate(loan.dueAt)}`}
        {loan.isOverdue && ' · прострочено'}
      </span>

      {/* Джерело підпису — `origin`, а не `requestedAt`: записаний власником запис запиту не мав. */}
      {loan.origin === 'RECORDED_EXISTING' ? (
        <span className="book__meta">
          Записано власником {formatDate(loan.createdAt)}
          {loan.handedAt !== null && ` · передано ${formatDate(loan.handedAt)}`}
        </span>
      ) : (
        loan.requestedAt !== null && (
          <span className="book__meta">Попросили {formatDate(loan.requestedAt)}</span>
        )
      )}

      {loan.message !== null && <span className="book__meta">Прохання: {loan.message}</span>}
      {loan.responseNote !== null && (
        <span className="book__meta">Відповідь: {loan.responseNote}</span>
      )}

      <LoanActions
        loan={loan}
        isOwner={isOwner}
        busyKey={busyKey}
        onAct={onAct}
        onConfirm={onConfirm}
      />

      <span className="book__meta">
        <Link href={`/copies/${loan.copy.id}/history`}>Історія примірника</Link>
      </span>
    </li>
  )
}

/** Підпис контрагента: записана власником позика не є «проханням» — origin визначає підпис. */
function counterpartLine(loan: Loan, isOwner: boolean): string {
  if (loan.origin === 'RECORDED_EXISTING') return isOwner ? 'у друга:' : 'власник:'

  return isOwner ? 'просить' : 'у'
}

/**
 * Кнопки рівно за таблицею §5.1.
 *
 * `switch` без `default` — навмисно: новий статус лоану має ламати збірку тут, а
 * не тихо лишати картку без жодної дії. Той самий прийом, що в `RelationAction`
 * на сторінці друзів.
 */
function LoanActions({
  loan,
  isOwner,
  busyKey,
  onAct,
  onConfirm,
}: {
  loan: Loan
  isOwner: boolean
  busyKey: string | undefined
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
  onConfirm: (confirmation: Confirmation) => void
}) {
  const busy = busyKey !== undefined
  const label = (action: LoanAction): string =>
    busyKey === `${action}:${loan.id}` ? 'Виконую…' : LOAN_ACTION_LABELS[action]

  const button = (action: LoanAction, danger = false): ReactNode => (
    <button
      key={action}
      type="button"
      className={danger ? 'button--danger' : 'button--ghost'}
      disabled={busy}
      onClick={() => {
        if (!danger) {
          void onAct(loan, action)
          return
        }

        onConfirm({
          title: `${LOAN_ACTION_LABELS[action]}?`,
          description: DANGER_DESCRIPTIONS[action],
          confirmLabel: LOAN_ACTION_LABELS[action],
          run: () => onAct(loan, action),
        })
      }}
    >
      {label(action)}
    </button>
  )

  switch (loan.status) {
    case 'REQUESTED':
      return (
        <div className="person__actions">
          {isOwner ? (
            <>
              <ApproveForm loan={loan} busy={busy} label={label('approve')} onAct={onAct} />
              {button('reject')}
            </>
          ) : (
            button('cancel')
          )}
        </div>
      )

    case 'APPROVED':
      return (
        <div className="person__actions">
          {/* §5.2: «отримав» тисне саме той, хто отримав. */}
          {!isOwner && button('hand_over')}
          {button('cancel', true)}
        </div>
      )

    case 'HANDED_OVER':
      return (
        <div className="person__actions">
          {isOwner ? (
            <>
              {button('return')}
              {button('mark_lost', true)}
            </>
          ) : (
            <span className="book__meta">Чекаємо, поки власник підтвердить повернення.</span>
          )}
        </div>
      )

    // Stage 10 (10d): статус лишається LOST; знахідка — окремий факт, а не перехід статусу.
    case 'LOST':
      return (
        <LostLoanRecovery
          loan={loan}
          isOwner={isOwner}
          busy={busy}
          submitting={busyKey === `recover:${loan.id}`}
          onRecover={(body) => void onAct(loan, 'recover', body)}
        />
      )

    // Stage 10 (10e, D6): запис власника, що чекає відповіді. Правка дат — лише до підтвердження (Q12).
    case 'PENDING_CONFIRMATION':
      return (
        <RecordedLoanActions
          loan={loan}
          isOwner={isOwner}
          busy={busy}
          busyKey={busyKey}
          onAct={onAct}
          onConfirm={onConfirm}
        />
      )

    case 'DECLINED':
      return (
        <span className="book__meta">
          {isOwner
            ? `${loan.borrower.displayName} відхилив(-ла) запис. Книжка знову вільна: можна записати заново.`
            : 'Ви відхилили цей запис.'}
        </span>
      )

    // Термінальні стани §5.1: з них не веде жоден перехід — ні для кого.
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
      return null
  }
}

const DANGER_DESCRIPTIONS: Readonly<Record<LoanAction, string>> = {
  approve: '',
  reject: '',
  cancel: 'Домовленість скасується, і книжка знову стане вільною. Другу сторону буде сповіщено.',
  hand_over: '',
  return: '',
  mark_lost:
    'Примірник позначиться як недоступний і залишиться за позичальником. Якщо книжка знайдеться, власник зможе це відмітити.',
  recover: '',
  confirm_record: '',
  decline_record: '',
  withdraw_record: '',
  amend_record: '',
}

/**
 * §8: `dueAt` приймається лише разом із `approve` — термін ставить власник,
 * погоджуючи запит. Тому поле живе всередині цієї дії, а не окремо.
 */
function ApproveForm({
  loan,
  busy,
  label,
  onAct,
}: {
  loan: Loan
  busy: boolean
  label: string
  onAct: (loan: Loan, action: LoanAction, body?: Record<string, unknown>) => Promise<void>
}) {
  const [dueAt, setDueAt] = useState(loan.dueAt ?? '')
  const [note, setNote] = useState('')

  return (
    <>
      <TextField
        id={`due-${loan.id}`}
        label="Повернути до"
        type="date"
        hint={loan.dueAt === null ? undefined : 'Позичальник просив саме цю дату.'}
        value={dueAt}
        onChange={(event) => {
          setDueAt(event.target.value)
        }}
      />
      <TextField
        id={`note-${loan.id}`}
        label="Відповідь"
        autoComplete="off"
        value={note}
        onChange={(event) => {
          setNote(event.target.value)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void onAct(loan, 'approve', {
            ...(dueAt === '' ? {} : { dueAt }),
            ...(note.trim() === '' ? {} : { note }),
          })
        }
      >
        {label}
      </button>
    </>
  )
}
