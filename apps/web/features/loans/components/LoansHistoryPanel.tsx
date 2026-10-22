'use client'

import Link from 'next/link'
import type { MyHistoryEntry } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { HistoryEntryLine } from '@/components/HistoryEntryLine'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMyHistory } from '@/app/lib/use-history'
import { HISTORY_VIEWS, type HistoryView } from '../model/loans-address'

const VIEW_LABELS: Readonly<Record<HistoryView, string>> = {
  borrowed: 'Що я брав',
  lent: 'Що в мене брали',
}

type LoansHistoryPanelProps = {
  view: HistoryView
  onViewChange: (view: HistoryView) => void
}

/**
 * §6.6, personal history: what I borrowed and what was borrowed from me. Mounted only on the
 * «Історія» tab, and it reads `GET /me/history` — never the current loans list.
 *
 * Both lists always carry names: the viewer is a side of every loan here, not a bystander, so the
 * §6.6 anonymisation does not apply to them.
 *
 * One request serves both sides, so switching between them sends nothing new.
 */
export function LoansHistoryPanel({ view, onViewChange }: LoansHistoryPanelProps) {
  const { state } = useMyHistory()

  return (
    <Tabs
      className="gap-8"
      value={view}
      onValueChange={(next) => {
        const selected = HISTORY_VIEWS.find((value) => value === next)
        if (selected !== undefined) onViewChange(selected)
      }}
    >
      <TabsList variant="line" aria-label="Вигляд історії">
        {HISTORY_VIEWS.map((value) => (
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
