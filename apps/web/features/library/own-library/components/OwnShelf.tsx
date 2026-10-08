'use client'

import type { LibraryGroup, LibraryQueryRequest } from '@bookswap/shared'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FormStatus } from '@/components/Form/FormStatus'
import { useOwnLibrary } from '@/app/lib/use-library'
import { LIBRARY_PATH, libraryBookHref } from '../model/library-address'
import { useLibraryFilters } from '../model/use-library-filters'
import { useShelfActions } from '../model/use-shelf-actions'
import { ArchivedCopyRow, CopyRow } from './CopyRow'
import { LibraryFilterForm } from './LibraryFilterForm'
import { GroupCard, ShelfContent } from './ShelfParts'

/**
 * Where a card leads: the page of the group's first copy (the order the API gives). A group always
 * has a copy; the fallback only satisfies the type.
 */
function groupHref(group: LibraryGroup): string {
  const [first] = group.copies

  return first === undefined ? LIBRARY_PATH : libraryBookHref(first.id)
}

/**
 * A row's own link, only when the card has several copies: the card already leads to the first one,
 * and each of the others needs a way in of its own.
 */
function openHref(group: LibraryGroup, copyId: string): string | undefined {
  return group.copies.length > 1 ? libraryBookHref(copyId) : undefined
}

type OwnShelfProps = {
  view: 'own' | 'out' | 'archive'
  /** The filters of the address; empty outside the own view. */
  filters: LibraryQueryRequest
  onApplyFilters: (filters: LibraryQueryRequest) => void
}

/**
 * The owner's own copies: all of them, the ones that are out, or the archive. The shelf actions live
 * here, so they survive switching between these three views; the filters do not, they belong to the
 * own view and come from the address.
 */
export function OwnShelf({ view, filters, onApplyFilters }: OwnShelfProps) {
  const filterForm = useLibraryFilters({ applied: filters, onApply: onApplyFilters })
  const { state, reload } = useOwnLibrary(view, filterForm.applied)
  const actions = useShelfActions(reload)

  return (
    <>
      {view === 'own' && <LibraryFilterForm filters={filterForm} />}

      <FormStatus error={actions.failure} />

      <ShelfContent
        state={state}
        view={view}
        renderGroup={(group) => (
          <GroupCard
            group={group}
            href={groupHref(group)}
            stretchedLink
            cornerMenu={group.copies.length === 1}
          >
            {group.copies.map((copy) =>
              view === 'archive' ? (
                <ArchivedCopyRow
                  key={copy.id}
                  copy={copy}
                  openHref={openHref(group, copy.id)}
                  title={group.work.title}
                  cornerMenu={group.copies.length === 1}
                  actions={actions}
                />
              ) : (
                <CopyRow
                  key={copy.id}
                  copy={copy}
                  openHref={openHref(group, copy.id)}
                  title={group.work.title}
                  cornerMenu={group.copies.length === 1}
                  actions={actions}
                  onSaved={reload}
                />
              ),
            )}
          </GroupCard>
        )}
      />

      <ConfirmDialog
        open={actions.pendingDelete !== undefined}
        title="Видалити примірник?"
        description="Запис зникне з вашої бібліотеки разом із нотаткою. Видалити можна лише примірник, який ніколи не мав позичань (навіть відхилених чи скасованих): історія позичань не стирається. Якщо книжки вже немає у вас — скористайтеся «Архівувати»."
        confirmLabel="Видалити"
        pending={actions.isBusy}
        onConfirm={actions.confirmDelete}
        onCancel={actions.cancelDelete}
      />
    </>
  )
}
