'use client'

import Link from 'next/link'
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronLeftIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import type { Loan, LoanRole, Me } from '@bookswap/shared'
import { SECTION_NOTICE_LINK, SectionNotice } from '@/components/SectionNotice'
import { ApiRequestError } from '@/app/lib/api'
import { loginHref } from '@/app/lib/return-to'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import { toLoanPageView, type LoanPageView } from '../model/loan-page-view'
import { LOAD_PROBLEM_WORDS, type LoanLoadProblem } from '../model/loan-page-state'
import { loanTimelineOf } from '../model/loan-timeline'
import { ALL_TAB, loansBackHref, type LoansTab } from '../model/loans-address'
import { useLoanPage } from '../model/use-loan-page'
import { toOwnerRequestView } from '../model/owner-request-view'
import { useLoanPageActions, type LoanPageActions } from '../model/use-loan-page-actions'
import { useLoansAddress } from '../model/use-loans-address'
import { LoanConfirmDialog } from './LoanConfirmDialog'
import { LoanFactsCard, LoanHero, LoanMessages, LoanTimelineCard } from './LoanPageCards'
import { LoanPanel } from './LoanPanel'
import { OwnerRequestView } from './OwnerRequestView'

type SingleLoanViewProps = {
  user: Me
  loanId: string
}

/** §8: `GET /loans/:id`. The API answers someone else's loan with 404 — the page shows the error. */
export function SingleLoanView({ user, loanId }: SingleLoanViewProps) {
  const { page, reload, retry } = useLoanPage(loanId)

  return (
    <LibrarySectionPage>
      <div className="loan-page">
        {page.status === 'loading' && (
          <>
            <LoanBack role={null} fallback={null} />
            <LoanPageSkeleton />
          </>
        )}
        {page.status === 'error' && (
          <>
            <LoanBack role={null} fallback={ALL_TAB} />
            <LoanLoadProblemNotice
              problem={page.problem}
              retrying={page.retrying}
              onRetry={retry}
            />
          </>
        )}
        {page.status === 'ready' && (
          <LoanPage
            loan={page.loan}
            user={user}
            reload={reload}
            notice={
              page.refreshProblem !== null && (
                <SectionNotice
                  role="alert"
                  icon={CircleAlertIcon}
                  title="Не вдалося оновити позику"
                  text="Показано дані з попереднього завантаження. Спробуйте ще раз."
                  action={<RetryButton retrying={false} onRetry={retry} />}
                />
              )
            }
          />
        )}
      </div>
    </LibrarySectionPage>
  )
}

/**
 * The page without its loan. A retry only where it may help (`unavailable`); a lost session leads
 * to the sign-in and back here; «← Позичання» above is the way out of the rest.
 */
function LoanLoadProblemNotice({
  problem,
  retrying,
  onRetry,
}: {
  problem: LoanLoadProblem
  retrying: boolean
  onRetry: () => void
}) {
  const { parameters } = useLoansAddress()
  const { title, text } = LOAD_PROBLEM_WORDS[problem]

  return (
    <SectionNotice
      role="alert"
      icon={CircleAlertIcon}
      title={title}
      text={text}
      action={
        problem === 'unavailable' ? (
          <RetryButton retrying={retrying} onRetry={onRetry} />
        ) : problem === 'signed-out' ? (
          <Link className={SECTION_NOTICE_LINK} href={loginHref(`/loans?${parameters.toString()}`)}>
            Увійти
          </Link>
        ) : undefined
      }
    />
  )
}

/**
 * While the retry runs it says so and takes no second press: `focusableWhenDisabled` keeps the
 * focus on it, and the hook's own guard ignores a press however it comes.
 */
function RetryButton({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <Button
      variant="outline"
      className="section-notice__button"
      disabled={retrying}
      focusableWhenDisabled
      aria-busy={retrying}
      onClick={onRetry}
    >
      {retrying && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {retrying ? 'Завантажую…' : 'Спробувати ще раз'}
    </Button>
  )
}

type LoanPageProps = {
  loan: Loan
  user: Me
  reload: () => Promise<void>
  /** A failed re-read, told above the loan it could not refresh. */
  notice: ReactNode
}

function LoanPage({ loan, user, reload, notice }: LoanPageProps) {
  const view = useMemo(() => toLoanPageView(loan, user.id), [loan, user.id])
  // The canvas's «Запит до власника» is this page while the owner answers: opened on a request, it
  // stays to show the answer's outcome, until «Відкрити позику» turns it into the loan's own page.
  const [isAnswering, setIsAnswering] = useState(
    () => view.role === 'owner' && loan.status === 'REQUESTED',
  )
  // While answering, a conflict (the borrower cancelled meanwhile) re-reads the loan: its new status
  // is the outcome the page then shows — itself, so no toast repeats it.
  const actions = useLoanPageActions(
    reload,
    isAnswering ? { onFailure: rereadOnConflict(reload), toasts: false } : {},
  )
  const panelTitle = useRef<HTMLHeadingElement>(null)
  const { parameters } = useLoansAddress()

  // The outcome's «Відкрити позику» is gone with it: the loan's panel takes the focus.
  const openLoan = () => {
    setIsAnswering(false)
    requestAnimationFrame(() => panelTitle.current?.focus())
  }

  return (
    <>
      {isAnswering ? (
        <>
          <LoanBack role={view.role} fallback={view.listTab} />
          {notice}
          <OwnerRequestView
            loan={loan}
            view={toOwnerRequestView(loan)}
            defaultLoanTermDays={user.defaultLoanTermDays}
            actions={actions}
            backHref={loansBackHref(parameters, view.role, view.listTab)}
            onOpenLoan={openLoan}
            titleRef={panelTitle}
          />
        </>
      ) : (
        <LoanDetails
          loan={loan}
          view={view}
          actions={actions}
          titleRef={panelTitle}
          notice={notice}
        />
      )}
      <LoanConfirmDialog actions={actions} fallbackFocus={panelTitle} />
    </>
  )
}

function rereadOnConflict(reload: () => Promise<void>) {
  return (failure: Error) =>
    failure instanceof ApiRequestError && failure.status === 409 ? reload() : undefined
}

type LoanDetailsProps = {
  loan: Loan
  view: LoanPageView
  actions: LoanPageActions
  titleRef: RefObject<HTMLHeadingElement | null>
  notice: ReactNode
}

/** The loan's own page: the book, where it stands with its actions, its history and its details. */
function LoanDetails({ loan, view, actions, titleRef, notice }: LoanDetailsProps) {
  const steps = useMemo(() => loanTimelineOf(loan), [loan])

  return (
    <>
      <LoanBack role={view.role} fallback={view.listTab} title={view.book.title} />
      {notice}
      <LoanHero view={view} />
      <div className="loan-page__grid">
        <div className="loan-page__panel">
          <LoanPanel loan={loan} role={view.role} actions={actions} titleRef={titleRef} />
        </div>
        <div className="loan-page__timeline">
          <LoanTimelineCard steps={steps} />
        </div>
        <div className="loan-page__facts">
          <LoanFactsCard facts={view.facts} copyId={loan.copy.id} />
        </div>
        <div className="loan-page__messages">
          <LoanMessages messages={view.messages} />
        </div>
      </div>
    </>
  )
}

/**
 * «← Позичання»: a plain link, never `history.back()` — a page opened from a notification or a
 * shared link has no list behind it. Opened from a list, it leads back to that tab with its search
 * and status; opened directly, to the list where the loan is (`fallback`). The side comes only from
 * the loaded loan — the one the server granted access by, never `?role=` alone — so until it arrives
 * (`fallback: null`) there is no link at all rather than one with a guessed side.
 */
function LoanBack({
  role,
  fallback,
  title,
}: {
  role: LoanRole | null
  fallback: LoansTab | null
  title?: string
}) {
  const { parameters } = useLoansAddress()

  return (
    <nav className="loan-back" aria-label="Шлях">
      {fallback === null ? (
        <span className="loan-back__link" aria-disabled="true">
          <ChevronLeftIcon aria-hidden="true" />
          Позичання
        </span>
      ) : (
        <Link className="loan-back__link" href={loansBackHref(parameters, role, fallback)}>
          <ChevronLeftIcon aria-hidden="true" />
          Позичання
        </Link>
      )}
      {title !== undefined && (
        <span className="loan-back__trail" aria-hidden="true">
          <span className="loan-back__slash">/</span>
          <span className="loan-back__current">{title}</span>
        </span>
      )}
    </nav>
  )
}

function LoanPageSkeleton() {
  return (
    <div className="loan-page__skeleton" aria-busy="true">
      <span className="sr-only" role="status">
        Завантажую…
      </span>
      <div className="loan-hero" aria-hidden="true">
        <Skeleton className="loan-hero__cover loan-hero__cover--placeholder" />
        <div className="loan-hero__body">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      </div>
      <Skeleton className="loan-page__skeleton-panel" aria-hidden="true" />
    </div>
  )
}
