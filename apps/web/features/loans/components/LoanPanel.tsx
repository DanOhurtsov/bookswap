'use client'

import { useId, useRef, type RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  EllipsisIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { Loan, LoanRole, LoanTermDays } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { LostLoanRecovery } from '@/components/LostLoanRecovery'
import { RecordedLoanActions } from '@/components/RecordedLoanActions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LOAN_ACTION_LABELS } from '@/app/lib/labels'
import { actionPlanOf, type PlannedAction } from '../model/loan-action-plan'
import { loanPanelOf } from '../model/loan-panel'
import type { BadgeTone } from '../model/loan-status'
import { useApproveForm } from '../model/use-approve-form'
import type { LoanPageActions } from '../model/use-loan-page-actions'
import { ApproveFields } from './ApproveFields'

const TONE_ICONS: Readonly<Record<BadgeTone, LucideIcon>> = {
  wait: ClockIcon,
  agreed: InfoIcon,
  hold: CircleCheckIcon,
  over: TriangleAlertIcon,
  done: CheckIcon,
}

type LoanPanelProps = {
  loan: Loan
  role: LoanRole
  defaultLoanTermDays: LoanTermDays | null
  actions: LoanPageActions
  /** The panel's title: the focus lands here when the action that had it is gone. */
  titleRef: RefObject<HTMLHeadingElement | null>
}

/**
 * The canvas's panel of the current state: where the loan stands, what the reader can do, and what
 * went wrong with the last attempt (`role="alert"`, right under the words it is about).
 */
export function LoanPanel({ loan, role, defaultLoanTermDays, actions, titleRef }: LoanPanelProps) {
  const titleId = useId()
  const panel = loanPanelOf(loan, role)
  const plan = actionPlanOf(loan.status, role)
  const Icon = TONE_ICONS[panel.tone]

  return (
    <section className="loan-panel" data-tone={panel.tone} aria-labelledby={titleId}>
      <div className="loan-panel__head">
        <span className="loan-panel__icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="loan-panel__words">
          <h4 id={titleId} ref={titleRef} tabIndex={-1} className="loan-panel__title">
            {panel.title}
          </h4>
          {panel.text !== null && <p className="loan-panel__text">{panel.text}</p>}
        </div>
        {plan.kind === 'buttons' && plan.menu.length > 0 && (
          <MoreActions loan={loan} items={plan.menu} actions={actions} />
        )}
      </div>

      {actions.confirmation === undefined && <FormStatus error={actions.failure} />}

      {plan.kind === 'answer' && (
        <AnswerForm loan={loan} defaultLoanTermDays={defaultLoanTermDays} actions={actions} />
      )}
      {plan.kind === 'buttons' && plan.buttons.length > 0 && (
        <div className="loan-panel__actions">
          {plan.buttons.map((planned) => (
            <ActionButton key={planned.action} loan={loan} planned={planned} actions={actions} />
          ))}
        </div>
      )}
      {plan.kind === 'record' && (
        <div className="loan-panel__legacy">
          <RecordedLoanActions
            loan={loan}
            isOwner={role === 'owner'}
            busy={actions.busyKey !== undefined}
            busyKey={actions.busyKey}
            onAct={actions.act}
            onConfirm={actions.confirm}
          />
        </div>
      )}
      {plan.kind === 'recover' && (
        <div className="loan-panel__legacy">
          <LostLoanRecovery
            loan={loan}
            isOwner={role === 'owner'}
            busy={actions.busyKey !== undefined}
            submitting={actions.busyKey === `recover:${loan.id}`}
            onRecover={(body) => void actions.act(loan, 'recover', body)}
          />
        </div>
      )}
    </section>
  )
}

type ActionProps = { loan: Loan; planned: PlannedAction; actions: LoanPageActions }

/** A panel button: a dangerous one asks first, the rest act at once; the pressed one says it works. */
function ActionButton({ loan, planned, actions }: ActionProps) {
  const isRunning = actions.busyKey === `${planned.action}:${loan.id}`

  return (
    <Button
      type="button"
      variant={planned.isPrimary ? 'default' : 'outline'}
      className={planned.isPrimary ? 'loan-action loan-action--primary' : 'loan-action'}
      disabled={actions.busyKey !== undefined}
      aria-busy={isRunning}
      onClick={(event) => {
        press(loan, planned, actions, event.currentTarget)
      }}
    >
      {isRunning && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {isRunning ? 'Виконую…' : planned.label}
    </Button>
  )
}

/** Acts at once, or — for an action with `confirm` — opens the dialog that will; `opener` gets the focus back. */
function press(
  loan: Loan,
  { action, label, confirm }: PlannedAction,
  actions: LoanPageActions,
  opener: HTMLElement | null,
) {
  if (confirm === null) {
    void actions.act(loan, action)
    return
  }

  actions.confirm({
    title: `${label}?`,
    description: confirm.description,
    confirmLabel: label,
    dismissLabel: confirm.dismissLabel,
    run: () => actions.act(loan, action),
    opener,
  })
}

/** The canvas's «⋯»: the rarer actions, each still confirmed; the focus comes back to «⋯». */
function MoreActions({
  loan,
  items,
  actions,
}: {
  loan: Loan
  items: PlannedAction[]
  actions: LoanPageActions
}) {
  const trigger = useRef<HTMLButtonElement>(null)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={trigger}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="loan-panel__more"
            aria-label="Інші дії з позикою"
            disabled={actions.busyKey !== undefined}
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="loan-panel__menu">
        {items.map((planned) => (
          <DropdownMenuItem
            key={planned.action}
            variant={planned.confirm === null ? 'default' : 'destructive'}
            className="loan-panel__menu-item"
            onClick={() => {
              press(loan, planned, actions, trigger.current)
            }}
          >
            {planned.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The owner's answer: the term and a note go with «Погодити» (§8); «Відмовити» needs neither. */
function AnswerForm({
  loan,
  defaultLoanTermDays,
  actions,
}: {
  loan: Loan
  defaultLoanTermDays: LoanTermDays | null
  actions: LoanPageActions
}) {
  const form = useApproveForm(loan, defaultLoanTermDays)

  return (
    <>
      <div className="loan-panel__form">
        <ApproveFields loan={loan} form={form} />
      </div>
      <div className="loan-panel__actions">
        <AnswerButton loan={loan} actions={actions} action="approve" body={form.body} />
        <AnswerButton loan={loan} actions={actions} action="reject" />
      </div>
    </>
  )
}

function AnswerButton({
  loan,
  actions,
  action,
  body,
}: {
  loan: Loan
  actions: LoanPageActions
  action: 'approve' | 'reject'
  body?: Record<string, unknown>
}) {
  const isRunning = actions.busyKey === `${action}:${loan.id}`

  return (
    <Button
      type="button"
      variant={action === 'approve' ? 'default' : 'outline'}
      className={action === 'approve' ? 'loan-action loan-action--primary' : 'loan-action'}
      disabled={actions.busyKey !== undefined}
      aria-busy={isRunning}
      onClick={() => void actions.act(loan, action, body)}
    >
      {isRunning && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {isRunning ? 'Виконую…' : LOAN_ACTION_LABELS[action]}
    </Button>
  )
}
