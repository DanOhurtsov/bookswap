'use client'

import { CATALOG_LIMITS } from '@bookswap/shared'
import { Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ManualDraft } from '../model/use-manual-draft'
import { MANUAL_ADD_ACTION, ManualInlineField } from './ManualInlineField'

type ManualAuthorsFieldProps = {
  draft: ManualDraft
  /** The names as text — `manualFieldDisplay(...).authors`. */
  names: readonly string[]
}

/**
 * The authors as ONE inline field (BS-76): names typed by hand, rows added and removed, and the whole
 * list confirmed or cancelled at once. «Скасувати» restores the list as it was when the editor opened.
 */
export function ManualAuthorsField({ draft, names }: ManualAuthorsFieldProps) {
  const { authors } = draft.values

  return (
    <ManualInlineField
      name="authors"
      label="Автори"
      addLabel="Додати автора"
      display={names.length === 0 ? null : names}
      editors={draft}
    >
      <div className="field">
        <label htmlFor="manual-author-0">Автор</label>
        {authors.map((name, index) => (
          <div
            key={index}
            // One line per author: the name shrinks, «Прибрати» stays beside it.
            className="person__actions col-start-1 flex-nowrap! [&>input]:min-w-0"
          >
            <input
              id={`manual-author-${String(index)}`}
              aria-label={index === 0 ? 'Автор' : `Автор ${String(index + 1)}`}
              autoComplete="off"
              value={name}
              onChange={(event) => {
                draft.change(
                  'authors',
                  authors.map((current, position) =>
                    position === index ? event.target.value : current,
                  ),
                )
              }}
            />
            {authors.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 cursor-pointer"
                aria-label={`Прибрати автора ${String(index + 1)}`}
                title="Прибрати"
                onClick={() => {
                  draft.change(
                    'authors',
                    authors.filter((_, position) => position !== index),
                  )
                }}
              >
                <Trash2Icon aria-hidden="true" className="size-[1.1rem]" />
              </Button>
            )}
          </div>
        ))}
        {authors.length < CATALOG_LIMITS.authorsMax && (
          <Button
            type="button"
            variant="unstyled"
            // The editor's grid keeps every row in the first column: ✓/✕ hold the second.
            className={cn(MANUAL_ADD_ACTION, 'col-start-1')}
            onClick={() => {
              draft.change('authors', [...authors, ''])
            }}
          >
            Додати автора
          </Button>
        )}
        {draft.errors.authors !== undefined && (
          <p className="field__error" role="alert">
            {draft.errors.authors}
          </p>
        )}
      </div>
    </ManualInlineField>
  )
}
