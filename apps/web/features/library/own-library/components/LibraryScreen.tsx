'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { FormStatus } from '@/components/Form/FormStatus'
import type { LibraryView } from '@/app/lib/use-library'
import { useSession } from '@/app/lib/use-session'
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
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  return <LibraryBody checklist={checklist} />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Моя бібліотека</h1>
      {children}
    </main>
  )
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
    <Shell>
      {checklist}

      <div className="actions">
        <Link href="/catalog/new">Додати книжку</Link>
        <Link href="/library/imports">Імпорт із CSV</Link>
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
    </Shell>
  )
}
