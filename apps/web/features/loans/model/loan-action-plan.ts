import type { LoanAction, LoanRole, LoanStatus } from '@bookswap/shared'
import { LOAN_ACTION_LABELS } from '@/app/lib/labels'

/**
 * What a dangerous action says before it runs. The button that closes the dialog says plainly that
 * nothing happens (`dismissLabel`); the one that acts carries the action's own label.
 */
export type ActionConfirmation = { description: string; dismissLabel: string }

/** One action the loan's panel offers; with `confirm` it asks first. */
export type PlannedAction = {
  action: LoanAction
  /** The button's words: a cancellation names what it cancels — the request or the loan. */
  label: string
  isPrimary: boolean
  confirm: ActionConfirmation | null
}

/**
 * What the panel of one loan offers, exactly per the §5.1 table (and Stage 10). The server still
 * decides "may I" — the panel only does not offer what is certain to be a 409.
 *
 * - `answer` — the owner's approval form (with the term, §8) and «Відмовити»;
 * - `buttons` — the panel's buttons, and the rarer ones behind «⋯» (`menu`);
 * - `record` — an owner's record awaiting an answer (`RecordedLoanActions`);
 * - `recover` — a lost book that may be found (`LostLoanRecovery`, status stays `LOST`).
 */
export type LoanActionPlan =
  | { kind: 'answer' }
  | { kind: 'buttons'; buttons: PlannedAction[]; menu: PlannedAction[] }
  | { kind: 'record' }
  | { kind: 'recover' }
  | { kind: 'none' }

/**
 * A `switch` without `default` on purpose: a new loan status must break the build here rather than
 * quietly leave the loan without any action.
 */
export function actionPlanOf(status: LoanStatus, role: LoanRole): LoanActionPlan {
  const isOwner = role === 'owner'

  switch (status) {
    case 'REQUESTED':
      // A cancelled request cannot be taken back: it asks first, like any other irreversible step.
      return isOwner ? { kind: 'answer' } : buttons([CANCEL_REQUEST])
    case 'APPROVED':
      // §5.2: "received" is pressed by exactly the one who received it — never by the owner.
      return buttons(isOwner ? [CANCEL_LOAN] : [primary('hand_over'), CANCEL_LOAN])
    case 'HANDED_OVER':
      // The return is the owner's to mark; the borrower has nothing to press until then.
      return isOwner ? buttons([primary('return')], [MARK_LOST]) : { kind: 'none' }
    case 'LOST':
      return { kind: 'recover' }
    case 'PENDING_CONFIRMATION':
      return { kind: 'record' }
    // Terminal states of §5.1: no transition leads out of them — for anyone.
    case 'REJECTED':
    case 'CANCELLED':
    case 'RETURNED':
    case 'DECLINED':
      return { kind: 'none' }
  }
}

function buttons(shown: PlannedAction[], menu: PlannedAction[] = []): LoanActionPlan {
  return { kind: 'buttons', buttons: shown, menu }
}

function primary(action: LoanAction): PlannedAction {
  return { action, label: LOAN_ACTION_LABELS[action], isPrimary: true, confirm: null }
}

/** The dismissing button of a dialog that is not about cancelling. */
const BACK = 'Назад'

const CANCEL_REQUEST: PlannedAction = {
  action: 'cancel',
  label: 'Скасувати запит',
  isPrimary: false,
  confirm: {
    description: 'Запит скасується, і власник більше не бачитиме його серед нових.',
    dismissLabel: 'Не скасовувати',
  },
}

const CANCEL_LOAN: PlannedAction = {
  action: 'cancel',
  label: 'Скасувати позику',
  isPrimary: false,
  confirm: {
    description:
      'Домовленість скасується, і книжка знову стане вільною. Другу сторону буде сповіщено.',
    dismissLabel: 'Не скасовувати',
  },
}

const MARK_LOST: PlannedAction = {
  action: 'mark_lost',
  label: LOAN_ACTION_LABELS.mark_lost,
  isPrimary: false,
  confirm: {
    description:
      'Примірник позначиться як недоступний і залишиться за позичальником. Якщо книжка знайдеться, власник зможе це відмітити.',
    dismissLabel: BACK,
  },
}

/**
 * The toast after an action the server accepted — never before, never on a failure. It states what
 * happened, nothing that will happen next.
 */
export const ACTION_DONE_MESSAGES: Readonly<Record<LoanAction, string>> = {
  approve: 'Запит погоджено',
  reject: 'Запит відхилено',
  cancel: 'Скасовано',
  hand_over: 'Отримання підтверджено',
  return: 'Повернення позначено. Позику завершено',
  mark_lost: 'Книжку позначено втраченою',
  recover: 'Позначено, що книжка знайшлася',
  confirm_record: 'Запис підтверджено',
  decline_record: 'Запис відхилено',
  withdraw_record: 'Запис відкликано',
  amend_record: 'Нові дати збережено',
}
