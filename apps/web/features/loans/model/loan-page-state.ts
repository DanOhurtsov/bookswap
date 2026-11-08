import type { Loan } from '@bookswap/shared'
import type { ResourceState } from '@/app/lib/resource-state'

/**
 * Why `GET /loans/:id` gave no loan, by the HTTP status alone — the server's own words are never
 * shown: they may be technical, in English or long.
 *
 * - `gone` — 403 and 404 alike (§8 answers someone else's loan with 404; a 403 must not tell the
 *   two apart either), and 400/410: the address names no loan this reader has. Asking again
 *   changes nothing.
 * - `signed-out` — 401: the session is over; signing in again is the way back.
 * - `unavailable` — no response at all (`httpStatus` absent: the network, a broken answer), 408,
 *   429 or 5xx: the loan may well be there, so a retry makes sense. An absent status is never
 *   read as 404.
 * - `failed` — any other answer: nothing to retry, nothing to claim about the loan.
 */
export type LoanLoadProblem = 'gone' | 'signed-out' | 'unavailable' | 'failed'

export function loadProblemOf(httpStatus: number | undefined): LoanLoadProblem {
  if (httpStatus === undefined) return 'unavailable'
  if (httpStatus === 401) return 'signed-out'
  if ([400, 403, 404, 410].includes(httpStatus)) return 'gone'
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return 'unavailable'

  return 'failed'
}

/** What the page says for each problem — its own words, never the server's. */
export const LOAD_PROBLEM_WORDS: Readonly<
  Record<LoanLoadProblem, { title: string; text: string }>
> = {
  gone: {
    title: 'Позику не знайдено',
    text: 'Можливо, це позичання вам не належить або його вже немає.',
  },
  'signed-out': {
    title: 'Сесія завершилася',
    text: 'Увійдіть знову, щоб побачити цю позику.',
  },
  unavailable: {
    title: 'Не вдалося завантажити позику',
    text: 'Сервер не відповів або зʼєднання перервалося. Спробуйте ще раз.',
  },
  failed: {
    title: 'Не вдалося відкрити позику',
    text: 'Поверніться до списку позичань і відкрийте її звідти.',
  },
}

/**
 * What one loan's page shows, given the legacy resource of `GET /loans/:id`.
 *
 * That resource answers `loading` on every `reload()`, the one after each action too. The page must
 * not fall back to its skeleton then: the panel, an open dialog and the focus in it would unmount
 * under the reader. So the last loan of this `loanId` stays on screen while a fresher one is read.
 * A failed re-read keeps it only while the failure is temporary (`unavailable`, told above it as
 * `refreshProblem`): after a 401, 403 or 404 the reader may no longer see that loan at all.
 *
 * Only a page without its loan shows the full-page problem — and, while it asks again, that same
 * problem with the retry at work (`retrying`), not a skeleton that would take the button away.
 *
 * The memory is per `loanId`; per user it is the component's: the screen is mounted anew for
 * another account (`LoansScreen`), so nothing of one reader's loan outlives a sign-out.
 */
export type LoanPageState =
  | { status: 'loading' }
  | { status: 'error'; problem: LoanLoadProblem; retrying: boolean }
  | { status: 'ready'; loan: Loan; refreshProblem: 'unavailable' | null }

/** What the page remembers of earlier answers for one `loanId`. */
export type LoanPageMemory = {
  loanId: string
  loan: Loan | undefined
  problem: LoanLoadProblem | undefined
}

export function loanPageStateOf(
  state: ResourceState<{ loan: Loan }>,
  memory: LoanPageMemory | undefined,
  loanId: string,
  retrying: boolean,
): LoanPageState {
  if (state.status === 'ready') {
    return { status: 'ready', loan: state.data.loan, refreshProblem: null }
  }

  const known = memory?.loanId === loanId ? memory : undefined
  const problem = state.status === 'error' ? loadProblemOf(state.httpStatus) : undefined

  if (known?.loan !== undefined && (problem === undefined || problem === 'unavailable')) {
    return { status: 'ready', loan: known.loan, refreshProblem: problem ?? null }
  }

  if (problem !== undefined) return { status: 'error', problem, retrying: false }
  if (retrying && known?.problem !== undefined) {
    return { status: 'error', problem: known.problem, retrying: true }
  }

  return { status: 'loading' }
}
