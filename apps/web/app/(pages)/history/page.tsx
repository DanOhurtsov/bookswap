'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import type { MyHistoryEntry } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { useSession } from '@/app/lib/use-session'
import { useMyHistory } from '@/app/lib/use-history'
import { HistoryEntryLine } from '@/components/HistoryEntryLine'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * §6.6, «Моя історія»: що я брав і що в мене брали.
 *
 * Обидва списки завжди з іменами — viewer тут сторона кожного лоану, а не
 * стороння людина, тож §6.6 до нього не застосовується.
 */
export default function HistoryPage() {
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

  return <HistoryScreen />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Моя історія</h1>
      {children}
    </main>
  )
}

const VIEWS = ['borrowed', 'lent'] as const

type View = (typeof VIEWS)[number]

const VIEW_LABELS: Readonly<Record<View, string>> = {
  borrowed: 'Що я брав',
  lent: 'Що в мене брали',
}

function HistoryScreen() {
  const [view, setView] = useState<View>('borrowed')
  const { state } = useMyHistory()

  return (
    <Shell>
      <Tabs
        className="gap-8"
        value={view}
        onValueChange={(next) => {
          const selected = VIEWS.find((value) => value === next)
          if (selected !== undefined) setView(selected)
        }}
      >
        <TabsList variant="line" aria-label="Вигляд історії">
          {VIEWS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {VIEW_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={view}>
          {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}
          {state.status === 'error' && <FormStatus error={new Error(state.message)} />}

          {state.status === 'ready' && state.data[view].length === 0 && (
            <p className="empty">
              {view === 'borrowed' ? 'Ви поки нічого не брали.' : 'У вас поки нічого не брали.'}
            </p>
          )}

          {state.status === 'ready' && (
            <ul className="books">
              {state.data[view].map((item, index) => (
                // Stage 10 (10f.3): a guest fact (`entry.names === false`) has no `loanId` — an
                // anonymous entry carries no identifier that could correlate two different slices
                // of history (the same rule as for someone else's history, §6.6).
                <HistoryCard
                  key={item.entry.names ? item.entry.loanId : `guest-${String(index)}`}
                  item={item}
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <p className="form__aside">
        <Link href="/loans">Позичання</Link> · <Link href="/library">Моя бібліотека</Link> ·{' '}
        <Link href="/notifications">Сповіщення</Link> · <Link href="/">На головну</Link>
      </p>
    </Shell>
  )
}

function HistoryCard({ item }: { item: MyHistoryEntry }) {
  return (
    <li className="book">
      <Link className="book__title" href={`/works/${item.copy.work.id}`}>
        {item.copy.work.title}
      </Link>
      <AuthorLine authors={item.copy.authors} />
      <EditionLine edition={item.copy.edition} />

      <ul className="copies">
        <HistoryEntryLine entry={item.entry} />
      </ul>

      <span className="book__meta">
        <Link href={`/copies/${item.copy.id}/history`}>Уся історія примірника</Link>
      </span>
    </li>
  )
}
