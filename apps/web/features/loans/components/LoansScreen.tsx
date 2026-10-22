'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import type { Me } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import { useSession } from '@/app/lib/use-session'
import {
  LOANS_TABS,
  historyViewHref,
  loansTabHref,
  readLoansAddress,
  tabOf,
  type LoansAddress,
  type LoansTab,
} from '../model/loans-address'
import { LoanListPanel } from './LoanListPanel'
import { LoansHistoryPanel } from './LoansHistoryPanel'
import { SingleLoanView } from './SingleLoanView'

/**
 * §5, §6.6 and §8: the «Позичання» section of «Моя бібліотека» — every loan of the person from both
 * sides, one loan by link, and the personal history (BS-143).
 */
export function LoansScreen() {
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <LibrarySectionPage>
        <p className="status status--pending">Перевіряю сесію…</p>
      </LibrarySectionPage>
    )
  }

  if (session.status === 'error') {
    return (
      <LibrarySectionPage>
        <FormStatus error={new Error(session.message)} />
      </LibrarySectionPage>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <LibrarySectionPage>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </LibrarySectionPage>
    )
  }

  // `useSearchParams` needs a Suspense boundary: without it Next cannot prerender a page that
  // depends on the query string.
  return (
    <Suspense
      fallback={
        <LibrarySectionPage>
          <p className="status status--pending">Завантажую…</p>
        </LibrarySectionPage>
      }
    >
      <LoansContent user={session.user} />
    </Suspense>
  )
}

/**
 * The fork between modes. Separate components rather than one with a conditional hook: `useLoan`,
 * `useLoans` and `useMyHistory` each run unconditionally inside the one mode that needs them, so an
 * inactive mode sends no request.
 */
function LoansContent({ user }: { user: Me }) {
  const address = readLoansAddress(useSearchParams())

  return address.mode === 'loan' ? (
    <SingleLoanView user={user} loanId={address.loanId} />
  ) : (
    <LoansTabs user={user} address={address} />
  )
}

const TAB_LABELS: Readonly<Record<LoansTab, string>> = {
  owner: 'Мої книжки',
  borrower: 'Я позичаю',
  history: 'Історія',
}

type LoansTabsProps = {
  user: Me
  address: Exclude<LoansAddress, { mode: 'loan' }>
}

/**
 * The tab and the history side live in the URL, not in `useState`.
 *
 * Otherwise they drift from the address two ways: changing the query on the same route does
 * nothing, and a reload opens a different tab than the address bar names. The URL is the state.
 *
 * Switching goes through `router.replace`, i.e. it **creates no history entry**: "back" returns to
 * the previous page, not the previous tab. On purpose — a tab is a filter, not a navigation step,
 * and littering the history with it would make a person press "back" three times to leave.
 */
function LoansTabs({ user, address }: LoansTabsProps) {
  const router = useRouter()
  const parameters = useSearchParams()
  const tab = tabOf(address)

  return (
    <LibrarySectionPage>
      <GuestLoansLink />

      <Tabs
        className="gap-8"
        value={tab}
        onValueChange={(next) => {
          const selected = LOANS_TABS.find((value) => value === next)
          if (selected !== undefined) router.replace(loansTabHref(parameters, selected))
        }}
      >
        <TabsList variant="line" aria-label="Вкладки позичань">
          {LOANS_TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab}>
          {address.mode === 'history' ? (
            <LoansHistoryPanel
              view={address.view}
              onViewChange={(view) => {
                router.replace(historyViewHref(parameters, view))
              }}
            />
          ) : (
            <LoanListPanel user={user} role={address.role} />
          )}
        </TabsContent>
      </Tabs>
    </LibrarySectionPage>
  )
}

function GuestLoansLink() {
  // Stage 10 (10f.3): the route exists only behind the server's features.guestLoans — the same
  // flag that hides the `/loans/guest` page itself.
  const { state: session } = useSession()

  if (session.status !== 'authenticated' || session.features?.guestLoans !== true) return null

  return (
    <div className="actions">
      <Link href="/loans/guest" className="link-underline">
        Гостьові позики
      </Link>
    </div>
  )
}
