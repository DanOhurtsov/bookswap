'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { FormStatus } from '@/components/Form/FormStatus'
import type { LibraryView } from '@/app/lib/use-library'
import { useSession } from '@/app/lib/use-session'
import { useGuestRedirect } from '@/app/lib/use-login-redirect'
import { LibrarySectionPage } from '@/features/library/sections/index.client'
import { isLibraryView } from '../model/library-address'
import { useLibraryAddress } from '../model/use-library-address'
import { BorrowedShelf } from './BorrowedShelf'
import { OwnShelf } from './OwnShelf'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type LibraryScreenProps = {
  /**
   * Stage 8h-2: the activation checklist, composed by the route and rendered
   * here. Passed in rather than imported so that this screen keeps knowing
   * only about copies: what sits above the shelf is the page's decision, and
   * the server-rendered seed the checklist needs never has to travel through
   * this component (§3.4 — composition over another prop drilled down).
   */
  checklist?: ReactNode
}

/**
 * §6.4: the owner's library. The session guard comes first, so everything below it can rely on a
 * signed-in user; the view tabs then pick which shelf to show.
 */
export function LibraryScreen({ checklist }: LibraryScreenProps) {
  const { state: session } = useSession()

  useGuestRedirect(session.status)

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

  return <LibraryBody checklist={checklist} />
}

const VIEW_BUTTONS: ReadonlyArray<{ value: LibraryView; label: string }> = [
  { value: 'own', label: 'Усі мої' },
  { value: 'out', label: 'Мої не вдома' },
  { value: 'borrowed', label: 'Чужі в мене' },
  { value: 'archive', label: 'Архів' },
]

function LibraryBody({ checklist }: LibraryScreenProps) {
  const { view, filters, selectView, applyFilters } = useLibraryAddress()

  return (
    <LibrarySectionPage>
      {checklist}

      <div className="actions">
        <Link href="/catalog/new" className="link-underline">
          Додати книжку
        </Link>
        <Link href="/library/imports" className="link-underline">
          Імпорт із CSV
        </Link>
      </div>

      <nav className="mb-10">
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (isLibraryView(next)) selectView(next)
          }}
        >
          <TabsList variant="line">
            {VIEW_BUTTONS.map((button) => (
              <TabsTrigger key={button.value} value={button.value}>
                {button.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>

      {view === 'borrowed' ? (
        <BorrowedShelf />
      ) : (
        <OwnShelf view={view} filters={filters} onApplyFilters={applyFilters} />
      )}
    </LibrarySectionPage>
  )
}
