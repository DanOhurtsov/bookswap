'use client'

import { useId, type FormEvent, type RefObject } from 'react'
import { SearchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type UserSearchFormProps = {
  /** Names the search landmark: the header's and the page's must differ. */
  label: string
  /** `compact` — the header: an icon button. `full` — the page: «Знайти» in words. */
  variant: 'compact' | 'full'
  text: string
  loading: boolean
  /** Where the validation message is rendered (the panel or under the page form), if shown. */
  errorId: string | undefined
  onTextChange: (text: string) => void
  onSubmit: () => void
  fieldRef?: RefObject<HTMLInputElement | null>
  /** The header panel the field controls, while it is open. */
  controls?: string | undefined
  onFieldClick?: () => void
}

/** One field «Ім’я або email» and «Знайти»: the header and the page differ only in layout. */
export function UserSearchForm({
  label,
  variant,
  text,
  loading,
  errorId,
  onTextChange,
  onSubmit,
  fieldRef,
  controls,
  onFieldClick,
}: UserSearchFormProps) {
  const fieldId = useId()
  const hintId = useId()
  const buttonLabel = loading ? 'Шукаю…' : 'Знайти'

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form
      role="search"
      aria-label={label}
      className={cn('flex gap-2', variant === 'full' && 'flex-col sm:flex-row')}
      onSubmit={handleSubmit}
      noValidate
    >
      <label className="sr-only" htmlFor={fieldId}>
        Ім’я або email
      </label>
      <input
        ref={fieldRef}
        id={fieldId}
        className={cn(
          'w-full min-w-0 rounded-lg border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
          variant === 'compact' ? 'h-9' : 'h-10',
        )}
        type="search"
        name="query"
        autoComplete="off"
        placeholder="Ім’я або email"
        value={text}
        aria-controls={controls}
        aria-invalid={errorId !== undefined || undefined}
        aria-describedby={errorId === undefined ? hintId : `${hintId} ${errorId}`}
        onChange={(event) => onTextChange(event.target.value)}
        onClick={onFieldClick}
      />
      {variant === 'compact' ? (
        <Button type="submit" size="icon" disabled={loading} aria-label={buttonLabel}>
          <SearchIcon aria-hidden="true" />
        </Button>
      ) : (
        <Button type="submit" size="lg" disabled={loading}>
          <SearchIcon aria-hidden="true" />
          {buttonLabel}
        </Button>
      )}
      <p id={hintId} className="sr-only">
        Ім’я — щонайменше два символи; email — лише повна точна адреса.
      </p>
    </form>
  )
}
