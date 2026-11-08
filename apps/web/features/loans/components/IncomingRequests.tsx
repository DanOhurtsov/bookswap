'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import type { LoanAction, Me } from '@bookswap/shared'
import { assertNever } from '@/app/lib/assert-never'
import { useSession } from '@/app/lib/use-session'
import { FormStatus } from '@/components/Form/FormStatus'
import { getInitials } from '@/components/Friends/UserAvatar'
import { SectionNotice } from '@/components/SectionNotice'
import { ShelfCover } from '@/components/ShelfCover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  INCOMING_REQUESTS_HREF,
  INCOMING_REQUESTS_SHOWN,
  answerConflictMessage,
  isAnswerConflict,
  type IncomingRequestCard as Card,
  type IncomingRequestsView,
} from '../model/incoming-requests-view'
import { useApproveForm } from '../model/use-approve-form'
import { useIncomingRequests } from '../model/use-incoming-requests'
import { useLoanActions } from '../model/use-loan-actions'
import { ApproveFields } from './ApproveFields'

/** The two answers this section gives; everything else about a loan stays on `/loans`. */
type Answer = Extract<LoanAction, 'approve' | 'reject'>

/** How a card tells its section about an answer: the section owns the list, the focus and what it says. */
interface AnswerHandlers {
  /** An answer is on its way: an earlier conflict's explanation is no longer news. */
  onStart: () => void
  onAnswered: (card: Card, answer: Answer) => Promise<void>
  /**
   * A failed answer. A conflict — the request was no longer waiting — is explained by the section, which
   * reads the list again and announces nothing; any other failure stays on its card.
   */
  onFailure: (card: Card, failure: Error) => Promise<void>
}

/** The canvas `.btn`: 44 px, 15 px semibold; the call to action in the brand green in both themes. */
const ACTION = 'h-11 gap-2 px-[18px] text-[15px] font-semibold'
const CTA = `${ACTION} bg-(--canvas-cta-bg) text-(--canvas-on-cta) hover:bg-(--canvas-cta-hover) active:bg-(--canvas-cta-hover)`

/**
 * BS-147: «Потребує вашої дії» on the home page (canvas «Main Page») — the requests on the owner's books,
 * answered right here as on `/loans`. A guest, and a session not yet known or failed, sees nothing and
 * asks for nothing: the request is sent only below this guard, in a body keyed by the user.
 */
export function IncomingRequests() {
  const { state: session } = useSession()

  if (session.status !== 'authenticated') return null

  return <IncomingRequestsBody key={session.user.id} user={session.user} />
}

function IncomingRequestsBody({ user }: { user: Me }) {
  const { view, retry, refresh } = useIncomingRequests(user.id)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [announcement, setAnnouncement] = useState('')
  const [conflict, setConflict] = useState<string>()
  const leaving = useRef(false)
  const shown = view.kind === 'ready' ? view.cards.map((card) => card.loan.id).join() : view.kind

  // An answered or stale card leaves the list with the focused button in it: the focus goes back to
  // the section's heading instead of dropping to the top of the page.
  useEffect(() => {
    if (!leaving.current) return
    leaving.current = false

    if (document.activeElement === null || document.activeElement === document.body) {
      heading.current?.focus()
    }
  }, [shown])

  // One read per conflict, started by the owner's own click: a PATCH is never repeated, and a read that
  // fails shows the section's error with its manual retry.
  const handlers: AnswerHandlers = {
    onStart: () => {
      setConflict(undefined)
    },
    onAnswered: async (card, answer) => {
      setAnnouncement(
        `Запит на «${card.title}» ${answer === 'approve' ? 'погоджено' : 'відхилено'}.`,
      )
      leaving.current = true
      await refresh()
    },
    onFailure: async (card, failure) => {
      if (!isAnswerConflict(failure)) return
      setConflict(answerConflictMessage(card.title, failure))
      setAnnouncement('')
      leaving.current = true
      await refresh()
    },
  }

  return (
    <section
      className="home-section"
      aria-labelledby={headingId}
      aria-busy={view.kind === 'loading'}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2 md:gap-2.5">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="home-section__title">
            Потребує вашої дії
          </h2>
          {view.kind === 'ready' && (
            <span className="incoming-requests__count">
              <span aria-hidden="true">{view.total}</span>
              <span className="sr-only">{view.totalLabel}</span>
            </span>
          )}
        </div>
        <SeeAllLink />
      </div>
      <FormStatus error={conflict} />
      <IncomingRequestsContent view={view} user={user} onRetry={retry} handlers={handlers} />
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  )
}

/** The canvas shortens the link on a phone; its name stays the full one at every width. */
function SeeAllLink() {
  return (
    <Link
      href={INCOMING_REQUESTS_HREF}
      className="group/see inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 text-[15px] font-semibold whitespace-nowrap text-(--bookswap-accent) no-underline"
    >
      <span aria-hidden="true" className="md:hidden">
        Усі
      </span>
      <span className="max-md:sr-only">Переглянути всі</span>
      <ArrowRightIcon
        aria-hidden="true"
        className="hidden size-[18px] transition-transform group-hover/see:translate-x-0.5 motion-reduce:transition-none md:block"
      />
    </Link>
  )
}

function IncomingRequestsContent({
  view,
  user,
  onRetry,
  handlers,
}: {
  view: IncomingRequestsView
  user: Me
  onRetry: () => void
  handlers: AnswerHandlers
}) {
  switch (view.kind) {
    case 'loading':
      // The placeholders hold the cards' places; the text says the same to a screen reader.
      return (
        <>
          <p className="sr-only">Шукаю запити на ваші книжки…</p>
          <div className="incoming-requests__list" aria-hidden="true">
            {Array.from({ length: INCOMING_REQUESTS_SHOWN }, (_, index) => (
              <Skeleton key={index} className="incoming-requests__placeholder" />
            ))}
          </div>
        </>
      )

    case 'error':
      return (
        <SectionNotice
          role="alert"
          icon={CircleAlertIcon}
          title={view.message}
          action={
            <Button variant="outline" className="section-notice__button" onClick={onRetry}>
              Спробувати ще раз
            </Button>
          }
        />
      )

    case 'empty':
      return (
        <SectionNotice
          tone="done"
          icon={CheckIcon}
          title="Усе опрацьовано"
          text="Нових запитів немає."
        />
      )

    case 'ready':
      return (
        <ul className="incoming-requests__list">
          {view.cards.map((card) => (
            <li key={card.loan.id} className="incoming-requests__item">
              <IncomingRequestCard card={card} user={user} handlers={handlers} />
            </li>
          ))}
        </ul>
      )

    default:
      return assertNever(view)
  }
}

/**
 * One request. «Погодити» opens the approval form of `/loans` inside the card — the return date and an
 * answer — and sends it from there; «Відмовити» answers at once, as on `/loans`. Each card has its own
 * actions, so one card's wait or failure is shown on that card only — except a conflict, which the
 * section explains while the list is read again. An answered card leaves the list when it is read again;
 * there is no undo (PO decision, 29.10.2026).
 */
function IncomingRequestCard({
  card,
  user,
  handlers,
}: {
  card: Card
  user: Me
  handlers: AnswerHandlers
}) {
  const { loan } = card
  const answer = useRef<Answer>('approve')
  const actions = useLoanActions(
    () => handlers.onAnswered(card, answer.current),
    (failure) => handlers.onFailure(card, failure),
  )
  const form = useApproveForm(loan, user.defaultLoanTermDays)
  const [approving, setApproving] = useState(false)
  const approveButton = useRef<HTMLButtonElement>(null)
  const fields = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const busy = actions.busyKey !== undefined
  const sending = (action: Answer) => actions.busyKey === `${action}:${loan.id}`

  const send = (action: Answer, body?: Record<string, unknown>) => {
    answer.current = action
    handlers.onStart()
    void actions.act(loan, action, body)
  }

  // The focus follows the form: into its first field when it opens, back to «Погодити» when it closes.
  const openForm = () => {
    flushSync(() => {
      setApproving(true)
    })
    fields.current?.querySelector('input')?.focus()
  }

  const closeForm = () => {
    flushSync(() => {
      setApproving(false)
    })
    approveButton.current?.focus()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    send('approve', form.body)
  }

  return (
    <article
      className={`incoming-request${approving ? ' is-approving' : ''}`}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="incoming-request__head">
        <Avatar className="incoming-request__avatar">
          {card.borrower.avatarUrl !== null && <AvatarImage src={card.borrower.avatarUrl} alt="" />}
          <AvatarFallback variant="pastel" name={card.borrower.displayName}>
            {getInitials(card.borrower.displayName)}
          </AvatarFallback>
        </Avatar>
        <span className="incoming-request__who">
          <span className="incoming-request__name">{card.borrower.displayName}</span>
          <time className="incoming-request__time" dateTime={card.requestedAt}>
            {card.requestedAgo}
          </time>
        </span>
        <span className="incoming-request__badge">Новий запит</span>
      </div>

      <div className="incoming-request__book">
        <span className="incoming-request__cover">
          {/* A cover this small has room for the title only; the authors are beside it. */}
          <ShelfCover bookId={card.bookId} url={card.coverUrl} title={card.title} authors="" />
        </span>
        <span className="incoming-request__text">
          <Link id={titleId} href={card.href} className="incoming-request__title">
            {card.title}
          </Link>
          {card.authors !== '' && <span className="incoming-request__authors">{card.authors}</span>}
          {card.proposedDue !== null && (
            <span className="incoming-request__due">
              <CalendarIcon aria-hidden="true" />
              <span>
                Поверне до <time dateTime={card.proposedDue.date}>{card.proposedDue.label}</time>
              </span>
            </span>
          )}
        </span>
      </div>

      {card.message !== null && <p className="incoming-request__message">«{card.message}»</p>}

      {/* A conflict is the section's to explain: this card is about to leave. */}
      <FormStatus error={isAnswerConflict(actions.failure) ? undefined : actions.failure} />

      {approving ? (
        <form
          className="incoming-request__form"
          noValidate
          onSubmit={onSubmit}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) closeForm()
          }}
        >
          <div ref={fields} className="incoming-request__fields">
            <ApproveFields loan={loan} form={form} />
          </div>
          <div className="incoming-request__actions">
            <Button type="submit" className={CTA} disabled={busy}>
              {sending('approve') ? (
                <>
                  <Spinner />
                  Погоджуємо…
                </>
              ) : (
                'Погодити'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={ACTION}
              disabled={busy}
              onClick={closeForm}
            >
              Скасувати
            </Button>
          </div>
        </form>
      ) : (
        <div className="incoming-request__actions">
          <Button
            ref={approveButton}
            className={CTA}
            disabled={busy}
            aria-expanded={false}
            onClick={openForm}
          >
            Погодити
          </Button>
          <Button
            variant="outline"
            className={ACTION}
            disabled={busy}
            onClick={() => {
              send('reject')
            }}
          >
            {sending('reject') && <Spinner />}
            Відмовити
          </Button>
        </div>
      )}
    </article>
  )
}

function Spinner() {
  return <LoaderCircleIcon aria-hidden="true" className="size-[18px] motion-safe:animate-spin" />
}
