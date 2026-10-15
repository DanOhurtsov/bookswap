'use client'

import type { CopyEntryMethod } from '@bookswap/shared'
import Link from 'next/link'
import { useRef, type RefObject } from 'react'
import { BookCover } from '@/components/BookCover'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AddResultFact, AddResultSource, AddResultView } from '../model/add-result-view'
import { UNKNOWN_VALUE } from '../model/edition-refine-view'
import { isOwned, quickAddActionsView, quickAddCardProps } from '../model/quick-add-card'
import { manualFormHref } from '../model/search-address-urls'
import type { QuickAddApi } from '../model/use-quick-add'
import { SOURCE_LABELS } from './ExternalResultCard'
import { QuickAddActions } from './QuickAddActions'
import { ghostButtonClass, ghostLinkClass, primaryLinkClass } from './screen-styles'

type AddResultDialogProps = {
  /** The chosen result; kept while the dialog closes, so its content does not vanish mid-animation. */
  view: AddResultView | undefined
  open: boolean
  quick: QuickAddApi
  entryMethod: CopyEntryMethod
  /** The search address: «Уточнити дані» carries it for the way back. */
  parameters: URLSearchParams
  /** The card button that opened the dialog: focus returns to it. */
  trigger: HTMLButtonElement | undefined
  onClose: () => void
}

/**
 * One chosen result of the add search (BS-114): its short details and what can be done next. Opening and
 * closing send nothing; the add operation lives in `useQuickAdd` above this dialog, so closing neither
 * cancels a request in flight nor clears its state, and reopening the result shows where it is now.
 */
export function AddResultDialog({
  view,
  open,
  quick,
  entryMethod,
  parameters,
  trigger,
  onClose,
}: AddResultDialogProps) {
  const heading = useRef<HTMLHeadingElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        // The heading, not the first action: Enter that opened the dialog must not land on «Додати».
        initialFocus={heading}
        // A card that left the list meanwhile cannot take focus back; then the default applies.
        finalFocus={() => (trigger?.isConnected === true ? trigger : true)}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 text-base sm:max-w-lg"
      >
        {view !== undefined && (
          <AddResultDialogBody
            view={view}
            heading={heading}
            quick={quick}
            entryMethod={entryMethod}
            parameters={parameters}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

type AddResultDialogBodyProps = {
  view: AddResultView
  heading: RefObject<HTMLHeadingElement | null>
  quick: QuickAddApi
  entryMethod: CopyEntryMethod
  parameters: URLSearchParams
}

function AddResultDialogBody({
  view,
  heading,
  quick,
  entryMethod,
  parameters,
}: AddResultDialogBodyProps) {
  const card =
    view.quickAdd === undefined
      ? undefined
      : quickAddCardProps(quick, entryMethod, view.quickAdd.identities, view.quickAdd.target)
  const owned = isOwned(card?.slot, view.ownership)
  const canRefine = card === undefined || quickAddActionsView(card.slot, owned).canRefine
  const archivedOnly = !owned && (view.ownership?.archivedCount ?? 0) > 0
  const refine = (
    <Link
      href={manualFormHref(view.refine, parameters)}
      // The only way forward for a work is drawn as the main action; next to «Додати» it is secondary.
      className={card === undefined ? primaryLinkClass : ghostLinkClass}
    >
      Уточнити дані
    </Link>
  )
  const close = (
    <DialogClose data-ui="button" className={ghostButtonClass}>
      Закрити
    </DialogClose>
  )

  return (
    <>
      <div className="grid min-h-0 gap-4 overflow-y-auto p-4">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4">
          <BookCover url={view.coverUrl} alt={`Обкладинка «${view.title}»`} />
          <div className="grid min-w-0 gap-1">
            <DialogTitle
              ref={heading}
              tabIndex={-1}
              className="text-lg leading-snug font-semibold wrap-anywhere outline-none"
            >
              {view.title}
            </DialogTitle>
            {view.authors !== undefined && <p className="m-0 wrap-anywhere">{view.authors}</p>}
          </div>
        </div>

        {view.facts.length > 0 && <FactList facts={view.facts} />}

        <DialogDescription className="text-sm">
          <SourceLine source={view.source} />
        </DialogDescription>

        {view.refineReason !== undefined && (
          <p className="m-0">
            {view.refineReason === 'WORK'
              ? 'Це запис про твір, а не про конкретне видання. Щоб додати книжку, уточніть видання.'
              : 'Джерело не дало ідентифікатора, за яким це видання можна додати напряму. Уточніть дані видання.'}
          </p>
        )}

        {archivedOnly && (
          <p className="m-0">
            Це видання є у вашому архіві.{' '}
            <Link href="/library?view=archive" className="link-underline text-(--bookswap-accent)">
              Відновити з архіву
            </Link>
          </p>
        )}
      </div>

      <div className="border-t border-(--line) p-4">
        {card === undefined ? (
          <div className="flex flex-wrap gap-2">
            {refine}
            {close}
          </div>
        ) : (
          <QuickAddActions slot={card.slot} owned={owned} onAdd={card.onAdd} onRetry={card.onRetry}>
            {canRefine && refine}
            {close}
          </QuickAddActions>
        )}
      </div>
    </>
  )
}

/** Label–value rows; an unknown value («Не вказано») is muted, so it never reads as data. */
export function FactList({ facts }: { facts: readonly AddResultFact[] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-(--bookswap-muted)">{fact.label}</dt>
          <dd
            className={
              fact.value === UNKNOWN_VALUE ? 'm-0 text-(--bookswap-muted)' : 'm-0 wrap-anywhere'
            }
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SourceLine({ source }: { source: AddResultSource }) {
  if (source.kind === 'CATALOG') return <>Джерело: каталог BookSwap</>

  if (source.kind === 'LOOKUP') {
    return (
      <>
        Знайдено за ISBN у{' '}
        {source.source === undefined ? 'зовнішньому джерелі' : SOURCE_LABELS[source.source]}
      </>
    )
  }

  return <>Джерело: {source.sources.map((name) => SOURCE_LABELS[name]).join(' · ')}</>
}
