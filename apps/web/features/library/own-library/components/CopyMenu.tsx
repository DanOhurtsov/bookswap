'use client'

import type { ReactNode } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  HandshakeIcon,
  PencilIcon,
  Trash2Icon,
  UserRoundPlusIcon,
} from 'lucide-react'
import type { OwnCopy } from '@bookswap/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSession } from '@/app/lib/use-session'
import { canRecordHandover, canToggleOwnerStatus } from '../model/copy-rules'

/** What an item of the menu can open: the edit form or one of the two handover forms. */
export type CopyMenuTarget = 'edit' | 'record' | 'recordGuest'

type RowMenuProps = {
  /** Names the trigger for a screen reader; the same on every row, so it carries the book's title. */
  label: string
  disabled: boolean
  children: ReactNode
}

/** The ⋮ button and the popup under it. The button sits above the card's link layer. */
function RowMenu({ label, disabled, children }: RowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={label}
            className="relative z-10 shrink-0"
          >
            <EllipsisVerticalIcon aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type CopyMenuProps = {
  copy: OwnCopy
  label: string
  disabled: boolean
  onSelectTarget: (target: CopyMenuTarget) => void
  onToggleStatus: () => void
  onArchive: () => void
  onDelete: () => void
}

/** The actions of a copy that is on the shelf. */
export function CopyMenu({
  copy,
  label,
  disabled,
  onSelectTarget,
  onToggleStatus,
  onArchive,
  onDelete,
}: CopyMenuProps) {
  const { state: session } = useSession()
  const guestLoansEnabled =
    session.status === 'authenticated' && session.features?.guestLoans === true
  const canRecord = canRecordHandover(copy)

  return (
    <RowMenu label={label} disabled={disabled}>
      <DropdownMenuItem
        onClick={() => {
          onSelectTarget('edit')
        }}
      >
        <PencilIcon aria-hidden="true" />
        Редагувати
      </DropdownMenuItem>

      {canToggleOwnerStatus(copy) && (
        <DropdownMenuItem onClick={onToggleStatus}>
          {copy.status === 'AVAILABLE' ? (
            <EyeOffIcon aria-hidden="true" />
          ) : (
            <EyeIcon aria-hidden="true" />
          )}
          {copy.status === 'AVAILABLE' ? 'Тимчасово не даю' : 'Знову даю'}
        </DropdownMenuItem>
      )}

      {canRecord && (
        <DropdownMenuItem
          onClick={() => {
            onSelectTarget('record')
          }}
        >
          <HandshakeIcon aria-hidden="true" />
          Записати передану книжку
        </DropdownMenuItem>
      )}

      {/* Stage 10 (10f.3): only behind the server's features.guestLoans — here and on the routes this
          form leads to (D2 stays an open release blocker, synthetic data only). */}
      {guestLoansEnabled && canRecord && (
        <DropdownMenuItem
          onClick={() => {
            onSelectTarget('recordGuest')
          }}
        >
          <UserRoundPlusIcon aria-hidden="true" />
          Позичити гостю
        </DropdownMenuItem>
      )}

      <DropdownMenuSeparator />

      <DropdownMenuItem onClick={onArchive}>
        <ArchiveIcon aria-hidden="true" />
        Архівувати
      </DropdownMenuItem>

      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2Icon aria-hidden="true" />
        Видалити
      </DropdownMenuItem>
    </RowMenu>
  )
}

type ArchivedCopyMenuProps = {
  label: string
  disabled: boolean
  onRestore: () => void
}

/** The only action of an archived copy. */
export function ArchivedCopyMenu({ label, disabled, onRestore }: ArchivedCopyMenuProps) {
  return (
    <RowMenu label={label} disabled={disabled}>
      <DropdownMenuItem onClick={onRestore}>
        <ArchiveRestoreIcon aria-hidden="true" />
        Відновити
      </DropdownMenuItem>
    </RowMenu>
  )
}
