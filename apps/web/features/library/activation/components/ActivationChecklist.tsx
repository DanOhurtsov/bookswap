'use client'

import Link from 'next/link'
import type { ActivationNextAction, ActivationResponse } from '@bookswap/shared'
import { assertNever } from '@/app/lib/assert-never'
import { useActivation, type ActivationView } from '../model/use-activation'
import type { ActivationInitialState } from '../model/activation-state'

type ActivationChecklistProps = {
  /** What the server already knew when it rendered the page, when there was a server. */
  initial?: ActivationInitialState
}

/**
 * Where each next action leads. R11 ties both to pages that already exist —
 * invite links belong to Stage 9, and this screen promises nothing about them.
 */
const NEXT_ACTION: Readonly<Record<ActivationNextAction, { href: string; label: string }>> = {
  ADD_BOOKS: { href: '/catalog/new', label: 'Додати книжку' },
  INVITE_FRIENDS: { href: '/friends', label: 'Запросити друзів' },
}

/**
 * Stage 8h-2, R11: progress towards the first ten books.
 *
 * The same component on all three screens it appears on — the library, the
 * add-book success step and a committed import — reading the one `['activation']`
 * query. None of them owns a private copy of the rule or of the count.
 */
export function ActivationChecklist({ initial }: ActivationChecklistProps) {
  const { view, retry } = useActivation(initial)

  if (view.status === 'hidden') return null

  return (
    <section className="activation" aria-label="Прогрес до перших 10 книжок">
      <ChecklistBody view={view} onRetry={retry} />
    </section>
  )
}

function ChecklistBody({ view, onRetry }: { view: ActivationView; onRetry: () => void }) {
  switch (view.status) {
    case 'loading':
      return <p className="status status--pending">Рахую вашу полицю…</p>

    case 'error':
      return (
        <div className="status status--error" role="alert">
          {/* The last known count is deliberately not shown beside this: after a
              failed read there is no way to say whether it is still true. The
              whole sentence comes from the hook — a read that failed on the
              server and one that failed in the browser are different facts. */}
          <p>{view.message}</p>
          <button type="button" className="button--ghost" onClick={onRetry}>
            Спробувати ще раз
          </button>
        </div>
      )

    case 'ready':
      return <Progress progress={view.progress} />

    // `hidden` never reaches here — the component returns null before rendering
    // the section at all — but the union stays exhaustive on purpose.
    case 'hidden':
      return null

    default:
      return assertNever(view)
  }
}

function Progress({ progress }: { progress: ActivationResponse }) {
  const { ownedCopyCount, target, hasReachedTarget, nextAction } = progress
  // Capped: an owner with 40 books has finished this checklist, not finished it
  // four times over. `<progress>` would clamp the bar anyway, but the number
  // beside it is read by people and by screen readers.
  const percent = Math.min(100, Math.round((ownedCopyCount / target) * 100))
  const action = NEXT_ACTION[nextAction]

  return (
    <>
      <h2 className="activation__title">Перші {target} книжок</h2>

      <p className="activation__meter">
        <progress
          className="activation__bar"
          value={percent}
          max={100}
          aria-label={`Заповнено на ${String(percent)}%`}
        />
        <span className="book__meta">
          {ownedCopyCount} з {target}
        </span>
      </p>

      <p>{message(ownedCopyCount, target, hasReachedTarget)}</p>

      <p className="actions">
        <Link className="activation__cta" href={action.href}>
          {action.label}
        </Link>
      </p>
    </>
  )
}

function message(ownedCopyCount: number, target: number, hasReachedTarget: boolean): string {
  if (hasReachedTarget) {
    return 'Полиця готова. Час запросити друзів — вони побачать, що у вас можна позичити.'
  }

  if (ownedCopyCount === 0) {
    return 'Полиця поки порожня. Перша книжка — найважливіша, решта йдуть швидше.'
  }

  // Phrased to avoid a counted noun: «ще 1», «ще 4» and «ще 8» all read the same
  // way, so no plural form has to be picked at runtime.
  return `Ще ${String(target - ownedCopyCount)} до ${String(target)} — і бібліотеку буде цікаво показати друзям.`
}
