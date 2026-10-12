'use client'

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { UserSearchResult } from '@bookswap/shared'
import { cn } from '@/lib/utils'
import { useFoundUserActions } from '../model/use-found-user-actions'
import { useUserSearch } from '../model/use-user-search'
import { isBlankSearch } from '../model/user-search'
import { UserSearchForm } from './UserSearchForm'
import { UserSearchPanel } from './UserSearchPanel'

const NO_RESULTS: readonly UserSearchResult[] = []

type UserSearchProps = {
  /** The signed-in person: searches are cached per viewer. */
  viewerId: string
  className?: string
}

/**
 * The people search in the header, on every page of a signed-in person. A single instance: the
 * header places it in its own row on narrow screens by CSS alone.
 *
 * Only a person opens the panel — typing, submitting, clicking back into the field. An answer
 * that arrives after the panel was closed is kept for when it is reopened, nothing more.
 */
export function UserSearch({ viewerId, className }: UserSearchProps) {
  const search = useUserSearch(viewerId)
  const actions = useFoundUserActions(
    viewerId,
    search.view.status === 'ready' ? search.view.results : NO_RESULTS,
    search.active,
  )
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const errorId = useId()
  const hasError = search.errors.form !== undefined
  const isPanelOpen = open && (search.view.status !== 'idle' || hasError)

  useEffect(() => {
    if (!isPanelOpen) return

    // A press anywhere outside closes the panel — the pointer twin of Tab-out.
    function handlePointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isPanelOpen])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || !isPanelOpen) return

    // Also keeps a search field from clearing itself: Escape here only closes the panel.
    event.preventDefault()
    setOpen(false)
    field.current?.focus()
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget

    // Tab out of the search closes it; a click on the panel's own text moves focus nowhere.
    if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false)
  }

  return (
    <div
      ref={root}
      className={cn('relative', className)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <UserSearchForm
        label="Швидкий пошук людей"
        variant="compact"
        text={search.text}
        loading={search.view.status === 'loading'}
        errorId={hasError ? errorId : undefined}
        fieldRef={field}
        controls={isPanelOpen ? panelId : undefined}
        onTextChange={(text) => {
          actions.dismissFailure()
          search.changeText(text)
          setOpen(!isBlankSearch(text))
        }}
        onSubmit={() => {
          search.submit()
          setOpen(!isBlankSearch(search.text))
        }}
        onFieldClick={() => setOpen(!isBlankSearch(search.text))}
      />

      {isPanelOpen && (
        <UserSearchPanel
          id={panelId}
          errorId={errorId}
          view={search.view}
          active={search.active}
          errors={search.errors}
          actions={actions}
          onRetry={search.submit}
          onNavigate={() => setOpen(false)}
        />
      )}
    </div>
  )
}
