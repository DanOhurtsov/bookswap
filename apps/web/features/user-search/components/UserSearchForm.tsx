'use client'

import { useId, type FormEvent } from 'react'
import { SearchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

type UserSearchFormProps = {
  text: string
  loading: boolean
  /** Where the validation message is rendered under the form, if shown. */
  errorId: string | undefined
  onTextChange: (text: string) => void
  onSubmit: () => void
}

/** One field «Ім’я або email» and «Знайти». */
export function UserSearchForm({
  text,
  loading,
  errorId,
  onTextChange,
  onSubmit,
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
      aria-label="Пошук людей"
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={handleSubmit}
      noValidate
    >
      <label className="sr-only" htmlFor={fieldId}>
        Ім’я або email
      </label>
      <input
        id={fieldId}
        className="h-10 w-full min-w-0 rounded-lg border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
        type="search"
        name="query"
        autoComplete="off"
        placeholder="Ім’я або email"
        value={text}
        aria-invalid={errorId !== undefined || undefined}
        aria-describedby={errorId === undefined ? hintId : `${hintId} ${errorId}`}
        onChange={(event) => onTextChange(event.target.value)}
      />
      <Button type="submit" size="lg" disabled={loading}>
        <SearchIcon aria-hidden="true" />
        {buttonLabel}
      </Button>
      <p id={hintId} className="sr-only">
        Ім’я — щонайменше два символи; email — лише повна точна адреса.
      </p>
    </form>
  )
}
