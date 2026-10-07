'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import type { OwnCopy } from '@bookswap/shared'
import { CreateGuestLoanForm } from '@/features/guest-loans/index.client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  CONDITION_LABELS,
  COPY_STATUS_LABELS,
  LOAN_STATUS_LABELS,
  VISIBILITY_LABELS,
  formatDate,
} from '@/app/lib/labels'
import { nextOwnerStatus } from '../model/copy-rules'
import { useCopyDraft } from '../model/use-copy-draft'
import { useCopyUpdate } from '../model/use-copy-update'
import type { ShelfActions } from '../model/use-shelf-actions'
import { CopyEditForm } from './CopyEditForm'
import { ArchivedCopyMenu, CopyMenu, type CopyMenuTarget } from './CopyMenu'
import { RecordExistingLoanForm } from './RecordExistingLoanForm'
import { CopyHistoryLink, CopyNote, CopyOpenLink } from './ShelfParts'

type CopyRowMode = 'idle' | CopyMenuTarget

type CopyRowProps = {
  copy: OwnCopy
  /** The copy's own page; set only when the card holds several copies. */
  openHref?: string
  /** The title of the book, for naming the row's menu. */
  title: string
  /** The menu goes to the card's top-right corner instead of the row's: the card has only this copy. */
  cornerMenu: boolean
  actions: ShelfActions
  onSaved: () => Promise<void>
}

/**
 * A copy on the shelf: what is known about it, and the menu of what can be done. The edit form and
 * the two handover forms open in a dialog from that menu, so the card itself carries no buttons.
 * The edit draft and the pending flag live here, above the dialogs, so they do not depend on which
 * one is open.
 */
export function CopyRow({ copy, openHref, title, cornerMenu, actions, onSaved }: CopyRowProps) {
  const [mode, setMode] = useState<CopyRowMode>('idle')
  const draft = useCopyDraft(copy)
  const update = useCopyUpdate({ copyId: copy.id, onSaved, onFailure: actions.reportFailure })

  function close(): void {
    setMode('idle')
  }

  function save(): void {
    const body = draft.submit()

    if (body === undefined) return

    void update.patch(body, close)
  }

  return (
    <RowLayout
      cornerMenu={cornerMenu}
      menu={
        <CopyMenu
          copy={copy}
          label={menuLabel(title)}
          disabled={update.pending || actions.isBusy}
          onSelectTarget={setMode}
          onToggleStatus={() => {
            void update.patch({ status: nextOwnerStatus(copy.status) })
          }}
          onArchive={() => {
            actions.archive(copy)
          }}
          onDelete={() => {
            actions.askToDelete(copy)
          }}
        />
      }
    >
      <OwnCopyMeta copy={copy} openHref={openHref} />

      <FormDialog
        title="Редагувати примірник"
        open={mode === 'edit'}
        locked={update.pending}
        onClose={close}
      >
        <CopyEditForm
          copyId={copy.id}
          draft={draft}
          pending={update.pending}
          onSave={save}
          onCancel={close}
        />
      </FormDialog>

      <FormDialog title="Записати передану книжку" open={mode === 'record'} onClose={close}>
        <RecordExistingLoanForm
          copyId={copy.id}
          onRecorded={async () => {
            close()
            await onSaved()
          }}
          onCancel={close}
        />
      </FormDialog>

      <FormDialog title="Позичити гостю" open={mode === 'recordGuest'} onClose={close}>
        <CreateGuestLoanForm
          copyId={copy.id}
          onCreated={async () => {
            close()
            await onSaved()
          }}
          onCancel={close}
        />
      </FormDialog>
    </RowLayout>
  )
}

type ArchivedCopyRowProps = {
  copy: OwnCopy
  openHref?: string
  title: string
  cornerMenu: boolean
  actions: ShelfActions
}

export function ArchivedCopyRow({
  copy,
  openHref,
  title,
  cornerMenu,
  actions,
}: ArchivedCopyRowProps) {
  return (
    <RowLayout
      cornerMenu={cornerMenu}
      menu={
        <ArchivedCopyMenu
          label={menuLabel(title)}
          disabled={actions.isBusy}
          onRestore={() => {
            actions.restore(copy)
          }}
        />
      }
    >
      <span className="book__meta">
        {CONDITION_LABELS[copy.condition]} · {VISIBILITY_LABELS[copy.visibility]}
      </span>
      <CopyNote note={copy.note} />
      <span className="book__meta">
        {openHref !== undefined && (
          <>
            <CopyOpenLink href={openHref} /> ·{' '}
          </>
        )}
        <CopyHistoryLink copyId={copy.id} />
      </span>
    </RowLayout>
  )
}

const menuLabel = (title: string): string => `Дії з примірником «${title}»`

type RowLayoutProps = {
  /** The row's menu. */
  menu: ReactNode
  /** Put the menu in the card's top-right corner, not at the right of this row. */
  cornerMenu: boolean
  children: ReactNode
}

function RowLayout({ menu, cornerMenu, children }: RowLayoutProps) {
  return (
    <li className="copy">
      <div className="flex items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1.5">{children}</div>
        {cornerMenu ? <div className="absolute top-2 right-2">{menu}</div> : menu}
      </div>
    </li>
  )
}

type FormDialogProps = {
  title: string
  open: boolean
  /** The form has a request in flight: the dialog stays until it is over. */
  locked?: boolean
  onClose: () => void
  children: ReactNode
}

function FormDialog({ title, open, locked = false, onClose, children }: FormDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !locked) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function OwnCopyMeta({ copy, openHref }: { copy: OwnCopy; openHref?: string }) {
  return (
    <>
      <span className="book__meta">
        {COPY_STATUS_LABELS[copy.status]} · {CONDITION_LABELS[copy.condition]} ·{' '}
        {VISIBILITY_LABELS[copy.visibility]}
        {copy.holder !== null && ` · у ${copy.holder.displayName}`}
        {copy.acquiredAt !== null && ` · відтоді: ${formatDate(copy.acquiredAt)}`}
      </span>
      <CopyNote note={copy.note} />

      <span className="book__meta">
        {/* Two different questions, two different sources. `activeLoan` is the one arrangement that
            occupies the book (§5.3.1); `pendingRequestCount` is how many people are waiting in
            the queue, and §5.2 allows several. A single "activeLoanId" for both cases would
            answer the wrong question. */}
        {copy.activeLoan !== null && (
          <>
            <Link className="relative z-10" href={`/loans?loanId=${copy.activeLoan.id}&role=owner`}>
              Позичання: {copy.activeLoan.counterpart.displayName} ·{' '}
              {LOAN_STATUS_LABELS[copy.activeLoan.status]}
            </Link>{' '}
            ·{' '}
          </>
        )}
        {copy.pendingRequestCount > 0 && (
          <>
            <Link className="relative z-10" href="/loans?role=owner">
              Запитів: {copy.pendingRequestCount}
            </Link>{' '}
            ·{' '}
          </>
        )}
        {openHref !== undefined && (
          <>
            <CopyOpenLink href={openHref} /> ·{' '}
          </>
        )}
        <CopyHistoryLink copyId={copy.id} />
      </span>
    </>
  )
}
