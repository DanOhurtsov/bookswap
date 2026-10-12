import Link from 'next/link'
import { describeError } from '@/app/lib/api'
import type { FieldErrors } from '@/app/lib/validation'
import { Button, buttonVariants } from '@/components/ui/button'
import type { FoundUserActions } from '../model/use-found-user-actions'
import { HEADER_RESULTS_LIMIT, userSearchPageHref, type UserSearchView } from '../model/user-search'
import { FoundUserList } from './FoundUserList'

const NOTE_CLASS = 'px-3 py-4 text-center text-sm text-muted-foreground'

type UserSearchPanelProps = {
  id: string
  errorId: string
  view: UserSearchView
  /** The query the shown results belong to — what «Показати всі» opens. */
  active: string | undefined
  errors: FieldErrors
  actions: FoundUserActions
  onRetry: () => void
  /** A link was followed: the panel has done its job. */
  onNavigate: () => void
}

/**
 * The results under the header search field: a region with links and buttons, not a listbox —
 * every row holds its own actions, reached with Tab like anything else on the page. A preview of
 * `HEADER_RESULTS_LIMIT` people; the whole answer is one link away.
 */
export function UserSearchPanel({
  id,
  errorId,
  view,
  active,
  errors,
  actions,
  onRetry,
  onNavigate,
}: UserSearchPanelProps) {
  const error = errors.form

  return (
    <div
      id={id}
      role="region"
      aria-label="Результати пошуку людей"
      className="absolute inset-x-0 top-full z-50 mt-2 max-h-96 overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 md:left-auto md:w-96"
    >
      {error !== undefined && (
        <p id={errorId} className="px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {actions.failure !== undefined && (
        <p className="px-3 py-2 text-sm text-destructive" role="alert">
          {describeError(actions.failure)}
        </p>
      )}
      <PanelBody
        view={view}
        active={active}
        actions={actions}
        onRetry={onRetry}
        onNavigate={onNavigate}
      />
    </div>
  )
}

function PanelBody({
  view,
  active,
  actions,
  onRetry,
  onNavigate,
}: Pick<UserSearchPanelProps, 'view' | 'active' | 'actions' | 'onRetry' | 'onNavigate'>) {
  switch (view.status) {
    case 'idle':
      return null
    case 'waiting':
    case 'loading':
      return (
        <p className={NOTE_CLASS} role="status">
          Шукаю людей…
        </p>
      )
    case 'failed':
      return (
        <div className="space-y-2 px-3 py-3 text-sm" role="alert">
          <p className="text-destructive">{describeError(view.error)}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Спробувати ще раз
          </Button>
        </div>
      )
    case 'ready':
      return view.results.length === 0 ? (
        <p className={NOTE_CLASS} role="status">
          Нікого не знайдено. Спробуйте інше ім’я або перевірте email.
        </p>
      ) : (
        <>
          <FoundUserList
            results={view.results.slice(0, HEADER_RESULTS_LIMIT)}
            actions={actions}
            onNavigate={onNavigate}
          />
          {/* `active` is the query of exactly these results: edited text has no results yet. */}
          {active !== undefined && (
            <div className="border-t p-2">
              <Link
                href={userSearchPageHref(active)}
                className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-full' })}
                onClick={onNavigate}
              >
                Показати всі
              </Link>
            </div>
          )}
        </>
      )
  }
}
