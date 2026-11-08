'use client'

import { Suspense, type ReactNode } from 'react'
import type { Me } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import { useSession } from '@/app/lib/use-session'
import { useGuestRedirect } from '@/app/lib/use-login-redirect'
import { useLoansAddress } from '../model/use-loans-address'
import { CurrentLoansPanel } from './CurrentLoansPanel'
import { LoansHistoryPanel } from './LoansHistoryPanel'
import { SingleLoanView } from './SingleLoanView'

/**
 * §5, §6.6 and §8: the «Позичання» section of «Моя бібліотека» — the current loans of both sides,
 * one loan by link, and the personal history (BS-143), drawn from the canvas (BS-153).
 *
 * Every state is inside `.canvas-theme`, the waiting ones too: the canvas palette (globals.css) is
 * chosen by that class, so the page never changes colour as it loads.
 */
export function LoansScreen() {
  return (
    <div className="canvas-theme loans-screen">
      <LoansSession />
    </div>
  )
}

function LoansSession() {
  const { state: session } = useSession()

  useGuestRedirect(session.status)

  if (session.status === 'loading') return <LoansStatus>Перевіряю сесію…</LoansStatus>

  if (session.status === 'error') {
    return (
      <LibrarySectionPage>
        <FormStatus error={new Error(session.message)} />
      </LibrarySectionPage>
    )
  }

  if (session.status !== 'authenticated') {
    return <LoansStatus>Потрібен вхід. Переадресовую…</LoansStatus>
  }

  // `useSearchParams` needs a Suspense boundary: without it Next cannot prerender a page that
  // depends on the query string.
  return (
    <Suspense fallback={<LoansStatus>Завантажую…</LoansStatus>}>
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
  const { address } = useLoansAddress()

  switch (address.mode) {
    case 'loan':
      // Mounted anew for another reader or another loan: the legacy resource keys its request by
      // the path alone, so without this a switched account would keep the previous one's loan.
      return (
        <SingleLoanView key={`${user.id}:${address.loanId}`} user={user} loanId={address.loanId} />
      )
    case 'list':
      return <CurrentLoansPanel user={user} side={address.side} filters={address.filters} />
    case 'history':
      return <LoansHistoryPanel filters={address.filters} />
  }
}

function LoansStatus({ children }: { children: ReactNode }) {
  return (
    <LibrarySectionPage>
      <p className="status status--pending">{children}</p>
    </LibrarySectionPage>
  )
}
