'use client'

import Link from 'next/link'
import { ArrowDownLeftIcon, ArrowUpRightIcon, ChevronRightIcon } from 'lucide-react'
import { getInitials } from '@/components/Friends/UserAvatar'
import { ShelfCover } from '@/components/ShelfCover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { LoanPageView } from '../model/loan-page-view'
import type { TimelineStep } from '../model/loan-timeline'

/** The canvas's head of the page: the cover, the state, the book and the other side. */
export function LoanHero({ view }: { view: LoanPageView }) {
  const { book, badge, counterpart } = view

  return (
    <header className="loan-hero">
      <span className="loan-hero__cover">
        <ShelfCover
          bookId={book.id}
          url={book.coverUrl}
          title={book.title}
          authors={book.authors}
        />
      </span>
      <div className="loan-hero__body">
        <p className="loan-hero__state">
          <span className={`loan-badge loan-badge--${badge.tone}`}>{badge.label}</span>
          <span className="loan-hero__relation">
            {view.role === 'owner' ? (
              <ArrowUpRightIcon aria-hidden="true" />
            ) : (
              <ArrowDownLeftIcon aria-hidden="true" />
            )}
            {view.relation}
          </span>
        </p>
        {/* The way to the book (and to asking for it again) is its title — so it looks like a link. */}
        <h3 className="loan-hero__title">
          <Link href={book.href}>{book.title}</Link>
        </h3>
        {book.authors !== '' && <p className="loan-hero__authors">{book.authors}</p>}
        <Link className="loan-person" href={counterpart.href}>
          <Avatar className="loan-person__avatar" aria-hidden="true">
            {counterpart.avatarUrl !== null && <AvatarImage src={counterpart.avatarUrl} alt="" />}
            <AvatarFallback variant="pastel" name={counterpart.name}>
              {getInitials(counterpart.name)}
            </AvatarFallback>
          </Avatar>
          <span className="loan-person__who">
            <span className="loan-person__name">{counterpart.name}</span>
            <span className="loan-person__role">{counterpart.role}</span>
          </span>
          <ChevronRightIcon aria-hidden="true" className="loan-person__chevron" />
        </Link>
      </div>
    </header>
  )
}

/** «Історія позики»: what happened with its date when the API has one, then what comes next. */
export function LoanTimelineCard({ steps }: { steps: readonly TimelineStep[] }) {
  return (
    <section className="loan-card loan-card--timeline" aria-labelledby="loan-timeline-title">
      <h4 id="loan-timeline-title" className="loan-card__title">
        Історія позики
      </h4>
      <ol className="loan-timeline">
        {steps.map((step) => (
          <li key={step.key} className="loan-timeline__step" data-tone={step.tone}>
            <span className="loan-timeline__rail" aria-hidden="true">
              <span className="loan-timeline__dot" />
              <span className="loan-timeline__line" />
            </span>
            <span className="loan-timeline__body">
              <span className="loan-timeline__title">
                {step.tone === 'next' ? `Далі: ${step.title}` : step.title}
                {step.date !== null && step.dateTime !== null && (
                  <>
                    {' · '}
                    <time className="loan-timeline__date" dateTime={step.dateTime}>
                      {step.date}
                    </time>
                  </>
                )}
              </span>
              {step.note !== null && <span className="loan-timeline__note">{step.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** «Деталі»: the term, the dates the loan carries, the edition and the copy — and the copy's history. */
export function LoanFactsCard({ facts, copyId }: { facts: LoanPageView['facts']; copyId: string }) {
  return (
    <section className="loan-card loan-card--facts" aria-labelledby="loan-facts-title">
      <h4 id="loan-facts-title" className="loan-card__title">
        Деталі
      </h4>
      <dl className="loan-facts">
        {facts.map(({ label, value }) => (
          <div key={label} className="loan-facts__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Link className="loan-card__link" href={`/copies/${encodeURIComponent(copyId)}/history`}>
        Історія примірника
        <ChevronRightIcon aria-hidden="true" />
      </Link>
    </section>
  )
}

/** The request's message and the owner's answer, each with who wrote it and when. */
export function LoanMessages({ messages }: { messages: LoanPageView['messages'] }) {
  if (messages.length === 0) return null

  return (
    <div className="loan-messages">
      {messages.map(({ key, heading, text, byline }) => (
        <section key={key} className="loan-card" aria-labelledby={`loan-message-${key}`}>
          <h4 id={`loan-message-${key}`} className="loan-card__title">
            {heading}
          </h4>
          <figure className="loan-message">
            <blockquote className="loan-message__text">«{text}»</blockquote>
            <figcaption className="loan-message__byline">{byline}</figcaption>
          </figure>
        </section>
      ))}
    </div>
  )
}
