'use client'

import Link from 'next/link'
import { useEffect, useRef, type ReactNode } from 'react'
import { useSession } from '@/app/lib/use-session'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import {
  LOANS_TABS,
  statusFiltersOf,
  type LoanSide,
  type LoansFilters,
  type LoansTab,
} from '../model/loans-address'
import { useLoansAddress } from '../model/use-loans-address'
import { LoansToolbar } from './LoansToolbar'

/** A tab chosen from the keyboard or the pointer while the tab row had the focus; see the effect below. */
let tabFocusedOnMount: LoansTab | null = null

const TAB_LABELS: Readonly<Record<LoansTab, string>> = {
  all: 'Усі',
  borrower: 'Я позичаю',
  owner: 'У мене позичають',
  history: 'Історія',
}

type LoansTabsLayoutProps = {
  tab: LoansTab
  filters: LoansFilters
  /**
   * Open loans per current tab, once the list is in. «Історія» has no count (PO, 05.11.2026), and
   * while it is open the current list is not read — so neither are its counts.
   */
  counts: Readonly<Record<LoanSide, number>> | undefined
  /** «3 позики» once the list is in: never the length of a list still loading. */
  resultLabel: string | undefined
  isLoading: boolean
  children: ReactNode
}

/**
 * The «Позичання» section of «Моя бібліотека» as the canvas draws it: the four tabs, the search and
 * status filter, the count, and the open tab's list. Each mode renders this frame around its own
 * list; the tab, the search and the status are read from and written to the address.
 */
export function LoansTabsLayout({
  tab,
  filters,
  counts,
  resultLabel,
  isLoading,
  children,
}: LoansTabsLayoutProps) {
  const { selectTab, setFilters } = useLoansAddress()
  const tabList = useRef<HTMLDivElement>(null)

  // The current tabs and «Історія» are different screens, each with its own read, so crossing
  // between them mounts this frame anew. The focus would drop to the page; the chosen tab takes it.
  useEffect(() => {
    if (tabFocusedOnMount !== tab) return
    tabFocusedOnMount = null
    tabList.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [tab])

  return (
    <LibrarySectionPage>
      <GuestLoansLink />

      <Tabs
        className="loans-tabs"
        value={tab}
        onValueChange={(next) => {
          const selected = LOANS_TABS.find((value) => value === next)
          if (selected === undefined) return
          if (tabList.current?.contains(document.activeElement) === true) {
            tabFocusedOnMount = selected
          }
          selectTab(selected)
        }}
      >
        <TabsList
          ref={tabList}
          variant="line"
          aria-label="Вкладки позичань"
          className="loans-tabs__list"
        >
          {LOANS_TABS.map((value) => (
            <TabsTrigger key={value} value={value} className="loans-tabs__tab">
              {TAB_LABELS[value]}
              {value !== 'history' && counts !== undefined && (
                <span className="loans-tabs__count">{counts[value]}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <LoansToolbar
          filters={filters}
          statuses={statusFiltersOf(tab)}
          onFiltersChange={setFilters}
        />

        <p className="loans-tabs__result" aria-live="polite">
          {resultLabel}
        </p>

        <TabsContent value={tab} className="loans-tabs__panel" aria-busy={isLoading}>
          {children}
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
    <div className="loans-guest-link">
      <Link href="/loans/guest" className="link-underline">
        Гостьові позики
      </Link>
    </div>
  )
}
