'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  CONDITION,
  COPY_STATUS,
  VISIBILITY,
  copyResponseSchema,
  libraryQueryRequestSchema,
  updateCopyRequestSchema,
  type BorrowedLibraryGroup,
  type Condition,
  type LibraryGroup,
  type LibraryQueryRequest,
  type OwnCopy,
  type OwnerCopyStatus,
  type Visibility,
} from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import {
  CONDITION_LABELS,
  COPY_STATUS_LABELS,
  VISIBILITY_LABELS,
  formatDate,
} from '@/app/lib/labels'
import { useBorrowedLibrary, useOwnLibrary, type LibraryView } from '@/app/lib/use-library'
import { useSession } from '@/app/lib/use-session'
import { validate, type FieldErrors } from '@/app/lib/validation'
import { invalidateActivation } from '@/features/library/activation/index.client'

type LibraryScreenProps = {
  /**
   * Stage 8h-2: the activation checklist, composed by the route and rendered
   * here. Passed in rather than imported so that this screen keeps knowing
   * only about copies: what sits above the shelf is the page's decision, and
   * the server-rendered seed the checklist needs never has to travel through
   * this component (§3.4 — composition over another prop drilled down).
   */
  checklist?: ReactNode
}

/**
 * §6.4: особиста бібліотека.
 *
 * Примірники згруповані за виданням («Шантарам ×3 · 2 вдома, 1 у Марка»), але
 * кожен лишається окремим рядком: кількість — це `COUNT` примірників, а не поле
 * «скільки» (§3). Тому редагувати й видаляти можна кожен окремо.
 */
export function LibraryScreen({ checklist }: LibraryScreenProps) {
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

  return <LibraryBody checklist={checklist} />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Моя бібліотека</h1>
      {children}
    </main>
  )
}

const VIEW_LABELS: Readonly<Record<LibraryView, string>> = {
  own: 'Усі мої',
  out: 'Мої не вдома',
  borrowed: 'Чужі в мене',
}

function LibraryBody({ checklist }: LibraryScreenProps) {
  const [view, setView] = useState<LibraryView>('own')

  return (
    <Shell>
      {checklist}

      <nav className="actions" aria-label="Вигляд бібліотеки">
        {(['own', 'out', 'borrowed'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={view === value ? undefined : 'button--ghost'}
            aria-pressed={view === value}
            onClick={() => {
              setView(value)
            }}
          >
            {VIEW_LABELS[value]}
          </button>
        ))}
      </nav>

      {/* Два різні в'ю — два різні компоненти з власними хуками. «Чужі в мене»
          віддає інший тип примірника й не має жодної мутації, тож спільний стан
          із фільтрами й `busyKey` їм не потрібен. */}
      {view === 'borrowed' ? <BorrowedView /> : <OwnView view={view} />}

      <p className="form__aside">
        <Link href="/catalog">Додати книжку</Link> ·{' '}
        <Link href="/library/imports">Імпорт із CSV</Link> · <Link href="/loans">Позичання</Link> ·{' '}
        <Link href="/history">Історія</Link> · <Link href="/friends">Друзі</Link> ·{' '}
        <Link href="/">На головну</Link>
      </p>
    </Shell>
  )
}

function BorrowedView() {
  const { state } = useBorrowedLibrary()

  return (
    <>
      {state.status === 'loading' && <p className="status status--pending">Завантажую полицю…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.groups.length === 0 && (
        <p className="empty">{emptyMessage('borrowed')}</p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.groups.map((group) => (
            <BorrowedGroupCard key={group.edition.id} group={group} />
          ))}
        </ul>
      )}
    </>
  )
}

function OwnView({ view }: { view: 'own' | 'out' }) {
  const [filters, setFilters] = useState<LibraryQueryRequest>({})
  const [statusFilter, setStatusFilter] = useState('')
  const [langFilter, setLangFilter] = useState('')
  const [queryFilter, setQueryFilter] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()
  const [pendingDelete, setPendingDelete] = useState<OwnCopy>()
  const queryClient = useQueryClient()

  const { state, reload } = useOwnLibrary(view, filters)

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    const result = validate(libraryQueryRequestSchema, {
      status: statusFilter === '' ? undefined : statusFilter,
      lang: langFilter.trim() === '' ? undefined : langFilter,
      q: queryFilter.trim() === '' ? undefined : queryFilter,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setFilters(result.data)
  }

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setFailure(undefined)
    setBusyKey(key)

    try {
      await action()
      // `await`: доки не приїхав новий список, кнопки лишаються заблокованими.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
      setPendingDelete(undefined)
    }
  }

  const removeCopy = (copyId: string): Promise<void> =>
    run(`delete:${copyId}`, async () => {
      await apiRequest(`/me/library/${copyId}`, { method: 'DELETE' })
      // Stage 8h-2: a copy fewer is a step back from ten, so the checklist
      // above the shelf has to hear about it. Inside the action, after the
      // DELETE resolved: a failed delete throws before this line, and nothing
      // is invalidated for a change that never happened. The legacy `reload()`
      // in `run` still follows — the two readers share no cache (R12).
      await invalidateActivation(queryClient)
    })

  return (
    <>
      {view === 'own' && (
        <form className="search" onSubmit={applyFilters} noValidate>
          <SelectField
            id="filter-status"
            label="Доступність"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value)
            }}
          >
            <option value="">будь-яка</option>
            {COPY_STATUS.map((value) => (
              <option key={value} value={value}>
                {COPY_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <TextField
            id="filter-lang"
            label="Мова"
            autoComplete="off"
            placeholder="uk"
            value={langFilter}
            error={errors.lang}
            onChange={(event) => {
              setLangFilter(event.target.value)
            }}
          />

          <TextField
            id="filter-q"
            label="Назва або автор"
            autoComplete="off"
            value={queryFilter}
            error={errors.q}
            onChange={(event) => {
              setQueryFilter(event.target.value)
            }}
          />

          <button type="submit">Застосувати</button>
        </form>
      )}

      <FormStatus error={failure} />

      {state.status === 'loading' && <p className="status status--pending">Завантажую полицю…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

      {state.status === 'ready' && state.data.groups.length === 0 && (
        <p className="empty">{emptyMessage(view)}</p>
      )}

      {state.status === 'ready' && (
        <ul className="books">
          {state.data.groups.map((group) => (
            <OwnGroupCard
              key={group.edition.id}
              group={group}
              busyKey={busyKey}
              onSaved={reload}
              onFailure={setFailure}
              onDelete={setPendingDelete}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== undefined}
        title="Видалити примірник?"
        description="Запис зникне з вашої бібліотеки разом із нотаткою — і разом з усією історією позичань цього примірника: і завершеними, і тими, що чекають на відповідь. Відновити її не можна. Примірник із підтвердженим або переданим позичанням видалити неможливо — спершу скасуйте або завершіть позичання."
        confirmLabel="Видалити"
        pending={busyKey !== undefined}
        onConfirm={() => {
          if (pendingDelete !== undefined) void removeCopy(pendingDelete.id)
        }}
        onCancel={() => {
          setPendingDelete(undefined)
        }}
      />
    </>
  )
}

function emptyMessage(view: LibraryView): string {
  if (view === 'out') return 'Усі ваші книжки вдома.'
  if (view === 'borrowed') return 'Чужих книжок у вас зараз немає.'

  return 'Полиця порожня. Знайдіть книжку в каталозі — і додайте примірник.'
}

function GroupHeader({ group }: { group: LibraryGroup | BorrowedLibraryGroup }) {
  return (
    <>
      <Link className="book__title" href={`/works/${group.work.id}`}>
        {group.work.title}
        {group.counts.total > 1 && ` ×${String(group.counts.total)}`}
      </Link>
      <AuthorLine authors={group.authors} />
      <EditionLine edition={group.edition} />
      {group.counts.total > 1 && (
        <span className="book__meta">
          {group.counts.home} вдома · {group.counts.out} не вдома
        </span>
      )}
    </>
  )
}

function BorrowedGroupCard({ group }: { group: BorrowedLibraryGroup }) {
  return (
    <li className="book">
      <GroupHeader group={group} />
      <ul className="copies">
        {group.copies.map((copy) => (
          <li className="copy" key={copy.id}>
            <span className="book__meta">
              {CONDITION_LABELS[copy.condition]} · власник: {copy.owner.displayName}
            </span>
            <span className="book__meta">
              {/* Джерело id явне: це лоан, яким книжка сюди потрапила, а не
                  «якийсь активний». Питання «де мій примірник» і «хто його
                  просить» мають різні відповіді (§5.2, §5.3.1). */}
              {copy.activeLoan !== null && (
                <Link href={`/loans?loanId=${copy.activeLoan.id}&role=borrower`}>
                  Моє позичання
                </Link>
              )}
              {copy.activeLoan !== null && ' · '}
              <Link href={`/copies/${copy.id}/history`}>Історія</Link>
            </span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function OwnGroupCard({
  group,
  busyKey,
  onSaved,
  onFailure,
  onDelete,
}: {
  group: LibraryGroup
  busyKey: string | undefined
  onSaved: () => Promise<void>
  onFailure: (error: unknown) => void
  onDelete: (copy: OwnCopy) => void
}) {
  return (
    <li className="book">
      <GroupHeader group={group} />
      <ul className="copies">
        {group.copies.map((copy) => (
          <CopyRow
            key={copy.id}
            copy={copy}
            busyKey={busyKey}
            onSaved={onSaved}
            onFailure={onFailure}
            onDelete={() => {
              onDelete(copy)
            }}
          />
        ))}
      </ul>
    </li>
  )
}

function CopyRow({
  copy,
  busyKey,
  onSaved,
  onFailure,
  onDelete,
}: {
  copy: OwnCopy
  busyKey: string | undefined
  onSaved: () => Promise<void>
  onFailure: (error: unknown) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [condition, setCondition] = useState<Condition>(copy.condition)
  const [visibility, setVisibility] = useState<Visibility>(copy.visibility)
  const [note, setNote] = useState(copy.note ?? '')
  const [acquiredAt, setAcquiredAt] = useState(copy.acquiredAt ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)

  /**
   * §5.1: `RESERVED` і `LENT_OUT` проставляє лише стейт-машина позичань, тож
   * перемикач пропонує рівно два стани власника. Коли книжка не вдома, він
   * недоступний — сервер відповість 409, і показувати кнопку, що гарантовано не
   * спрацює, гірше за чесне «недоступно».
   */
  const canToggleStatus =
    copy.isHome && (copy.status === 'AVAILABLE' || copy.status === 'UNAVAILABLE')

  async function save(): Promise<void> {
    const result = validate(updateCopyRequestSchema, {
      condition,
      visibility,
      note: note.trim() === '' ? null : note,
      acquiredAt: acquiredAt === '' ? null : acquiredAt,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setPending(true)

    try {
      await apiRequest(`/me/library/${copy.id}`, {
        method: 'PATCH',
        body: result.data,
        schema: copyResponseSchema,
      })

      setOpen(false)
      await onSaved()
    } catch (error) {
      onFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setPending(false)
    }
  }

  async function toggleStatus(next: OwnerCopyStatus): Promise<void> {
    setPending(true)

    try {
      await apiRequest(`/me/library/${copy.id}`, {
        method: 'PATCH',
        body: { status: next },
        schema: copyResponseSchema,
      })

      await onSaved()
    } catch (error) {
      onFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="copy">
      <span className="book__meta">
        {COPY_STATUS_LABELS[copy.status]} · {CONDITION_LABELS[copy.condition]} ·{' '}
        {VISIBILITY_LABELS[copy.visibility]}
        {copy.holder !== null && ` · у ${copy.holder.displayName}`}
        {copy.acquiredAt !== null && ` · відтоді: ${formatDate(copy.acquiredAt)}`}
      </span>
      {copy.note !== null && <span className="book__meta">Нотатка: {copy.note}</span>}

      <span className="book__meta">
        {/* Два різні питання — два різні джерела. `activeLoan` — єдина
            домовленість, що займає книжку (§5.3.1); `pendingRequestCount` —
            скільки людей чекає у черзі, а їх §5.2 дозволяє кілька. Один
            «activeLoanId» на обидва випадки відповідав би не на те. */}
        {copy.activeLoan !== null && (
          <>
            <Link href={`/loans?loanId=${copy.activeLoan.id}&role=owner`}>
              Позичання: {copy.activeLoan.counterpart.displayName}
            </Link>{' '}
            ·{' '}
          </>
        )}
        {copy.pendingRequestCount > 0 && (
          <>
            <Link href="/loans?role=owner">Запитів: {copy.pendingRequestCount}</Link> ·{' '}
          </>
        )}
        <Link href={`/copies/${copy.id}/history`}>Історія</Link>
      </span>

      {open ? (
        <div className="form">
          <SelectField
            id={`edit-condition-${copy.id}`}
            label="Стан"
            value={condition}
            onChange={(event) => {
              setCondition(event.target.value as Condition)
            }}
          >
            {CONDITION.map((value) => (
              <option key={value} value={value}>
                {CONDITION_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <SelectField
            id={`edit-visibility-${copy.id}`}
            label="Кому показувати"
            value={visibility}
            onChange={(event) => {
              setVisibility(event.target.value as Visibility)
            }}
          >
            {VISIBILITY.map((value) => (
              <option key={value} value={value}>
                {VISIBILITY_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <TextField
            id={`edit-note-${copy.id}`}
            label="Нотатка"
            hint="Видно лише вам."
            value={note}
            error={errors.note}
            onChange={(event) => {
              setNote(event.target.value)
            }}
          />

          <TextField
            id={`edit-acquired-${copy.id}`}
            label="Коли зʼявилася"
            type="date"
            value={acquiredAt}
            error={errors.acquiredAt}
            onChange={(event) => {
              setAcquiredAt(event.target.value)
            }}
          />

          <div className="person__actions">
            <button type="button" disabled={pending} onClick={() => void save()}>
              {pending ? 'Зберігаю…' : 'Зберегти'}
            </button>
            <button
              type="button"
              className="button--ghost"
              disabled={pending}
              onClick={() => {
                setOpen(false)
              }}
            >
              Скасувати
            </button>
          </div>
        </div>
      ) : (
        <div className="person__actions">
          <button
            type="button"
            className="button--ghost"
            disabled={pending || busyKey !== undefined}
            onClick={() => {
              setOpen(true)
            }}
          >
            Редагувати
          </button>

          {canToggleStatus && (
            <button
              type="button"
              className="button--ghost"
              disabled={pending || busyKey !== undefined}
              onClick={() =>
                void toggleStatus(copy.status === 'AVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE')
              }
            >
              {copy.status === 'AVAILABLE' ? 'Тимчасово не даю' : 'Знову даю'}
            </button>
          )}

          <button
            type="button"
            className="button--ghost"
            disabled={pending || busyKey !== undefined}
            onClick={onDelete}
          >
            Видалити
          </button>
        </div>
      )}
    </li>
  )
}
