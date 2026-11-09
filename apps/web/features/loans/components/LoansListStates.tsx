'use client'

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CircleAlertIcon,
  ClockIcon,
  SearchXIcon,
} from 'lucide-react'
import { SectionNotice } from '@/components/SectionNotice'
import { Button } from '@/components/ui/button'
import type { LoanRole } from '@bookswap/shared'
import type { LoanListView } from '../model/loan-row'
import { LoanRowList } from './LoanRows'
import { NewLoanMenu } from './LoansToolbar'

/** Which list is empty: the current loans of a side (or both), or the history. */
export type LoansListKind = 'all' | LoanRole | 'history'

type LoansListBodyProps = {
  view: LoanListView
  kind: LoansListKind
  onReset: () => void
}

/** The rows, or what stands in their place — with «позик немає» never mistaken for «нічого не знайдено». */
export function LoansListBody({ view, kind, onReset }: LoansListBodyProps) {
  switch (view.empty) {
    case null:
      return <LoanRowList rows={view.rows} />
    case 'results':
      return <NoResults text={view.noResultsText} onReset={onReset} />
    case 'none':
      return kind === 'history' ? <EmptyCompact {...EMPTY_HISTORY} /> : <EmptyLoans />
    case 'side':
      return kind === 'owner' || kind === 'borrower' ? (
        <EmptyCompact {...EMPTY_SIDES[kind]} />
      ) : (
        <EmptyLoans />
      )
  }
}

/** Canvas «EmptyState / variant = all»: no current loan at all. */
function EmptyLoans() {
  return (
    <div className="loans-empty">
      <span className="loans-empty__icon loans-empty__icon--accent" aria-hidden="true">
        <BookOpenIcon />
      </span>
      <h3 className="loans-empty__title">Тут поки немає позик</h3>
      <p className="loans-empty__text">
        Коли ви позичите книжку другові або попросите книжку в когось, позика з’явиться тут — разом
        зі статусом і датою повернення.
      </p>
      <div className="loans-empty__actions">
        <NewLoanMenu />
        <Link href="/catalog" className="loans-empty__secondary">
          Перейти до каталогу
        </Link>
      </div>
    </div>
  )
}

type EmptyCompactProps = {
  icon: LucideIcon
  title: string
  text: string
  link?: { href: string; label: string }
}

/** The canvas's compact variants: this side is empty, the other is not. */
const EMPTY_SIDES: Readonly<Record<LoanRole, EmptyCompactProps>> = {
  borrower: {
    icon: ArrowDownLeftIcon,
    title: 'Ви зараз нічого не позичаєте',
    text: 'Знайдіть книжку в бібліотеках друзів і надішліть запит.',
    link: { href: '/catalog', label: 'Відкрити каталог' },
  },
  owner: {
    icon: ArrowUpRightIcon,
    title: 'Ваші книжки всі вдома',
    text: 'Коли друг попросить книжку, запит з’явиться тут.',
    link: { href: '/library', label: 'Перейти до книжок' },
  },
}

/** BS-142 keeps every record, open ones too: an empty history means no loan at all yet. */
const EMPTY_HISTORY: EmptyCompactProps = {
  icon: ClockIcon,
  title: 'Історія поки порожня',
  text: 'Тут з’являться ваші позики — і поточні, і завершені.',
}

function EmptyCompact({ icon: Icon, title, text, link }: EmptyCompactProps) {
  return (
    <div className="loans-empty loans-empty--compact">
      <span className="loans-empty__icon" aria-hidden="true">
        <Icon />
      </span>
      <h3 className="loans-empty__title">{title}</h3>
      <p className="loans-empty__text">{text}</p>
      {link !== undefined && (
        <Link href={link.href} className="loans-empty__link">
          {link.label}
        </Link>
      )}
    </div>
  )
}

/** Canvas «NoResults»: loans exist, the search or the status left none; the tab stays. */
function NoResults({ text, onReset }: { text: string; onReset: () => void }) {
  return (
    <div className="loans-empty">
      <span className="loans-empty__icon" aria-hidden="true">
        <SearchXIcon />
      </span>
      <h3 className="loans-empty__title">Нічого не знайдено</h3>
      <p className="loans-empty__text">{text}</p>
      <Button variant="unstyled" className="loans-empty__secondary" onClick={onReset}>
        Скинути пошук і фільтри
      </Button>
    </div>
  )
}

/** A read that failed, with a retry the person starts: nothing is read again on its own. */
export function LoansLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SectionNotice
      role="alert"
      icon={CircleAlertIcon}
      title="Не вдалося завантажити позики."
      text={message}
      action={
        <Button variant="outline" className="section-notice__button" onClick={onRetry}>
          Спробувати ще раз
        </Button>
      }
    />
  )
}
