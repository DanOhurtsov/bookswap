'use client'

import {
  AUTHOR_ROLE,
  authorRoleSchema,
  catalogSearchResponseSchema,
  type AuthorMatch,
  type AuthorRole,
} from '@bookswap/shared'
import { useState } from 'react'
import { useController, type Control } from 'react-hook-form'
import { apiRequest, describeError } from '@/app/lib/api'
import { AUTHOR_ROLE_LABELS } from '@/app/lib/labels'
import { SelectField, TextField } from '@/components/Form/FormFields'
import type { AuthorFormValue } from '../model/author-list'
import type { WorkCorrectionFormValues } from '../model/work-form'

type AuthorFormRowProps = {
  control: Control<WorkCorrectionFormValues>
  index: number
  /** Existing authors' current name/transliteration, by id — `authorLookup()`. */
  knownAuthors: ReadonlyMap<string, { name: string; nameLatin: string | null }>
  canRemove: boolean
  onRemove: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}

async function searchAuthorCandidates(name: string): Promise<AuthorMatch[]> {
  const response = await apiRequest(`/catalog/search?q=${encodeURIComponent(name)}`, {
    schema: catalogSearchResponseSchema,
  })

  return response.authorMatches
}

function AuthorSearchError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="alert alert--error" role="alert">
      <p>Не вдалося перевірити наявних авторів: {message}</p>
      <button type="button" className="button--ghost" onClick={onRetry}>
        Спробувати ще раз
      </button>
    </div>
  )
}

function AuthorCandidates({
  candidates,
  onSelect,
}: {
  candidates: AuthorMatch[]
  onSelect: (candidate: AuthorMatch) => void
}) {
  if (candidates.length === 0) {
    return <p className="empty">Схожих авторів не знайшлося.</p>
  }

  return (
    <ul className="people">
      {candidates.map((candidate) => (
        <li className="person" key={candidate.id}>
          <span>
            <span className="person__name">{candidate.name}</span>
            <span className="person__meta">
              творів у каталозі: {candidate.workCount}
              {candidate.nameLatin !== null && ` · ${candidate.nameLatin}`}
            </span>
          </span>
          <button type="button" onClick={() => onSelect(candidate)}>
            Це він/вона
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * R10a's minimal 8e-3 author editor: pick an existing author (via
 * `catalog/search`) or type a new one, change role, remove the link, reorder
 * with Up/Down buttons (no drag-and-drop). Renaming an existing author is
 * never offered: R10 forbids editing the shared `Author` row through one
 * Work's correction, so typing a new name on an existing-author row switches
 * that row to "new author" instead of mutating the selection.
 */
export function AuthorFormRow({
  control,
  index,
  knownAuthors,
  canRemove,
  onRemove,
  onMoveUp,
  onMoveDown,
}: AuthorFormRowProps) {
  const { field } = useController({ control, name: `authors.${index}` as const })
  const author: AuthorFormValue = field.value
  const isExisting = author.authorId !== undefined
  const [displayName, setDisplayName] = useState(
    () =>
      (author.authorId !== undefined ? knownAuthors.get(author.authorId)?.name : author.name) ?? '',
  )
  const [candidates, setCandidates] = useState<AuthorMatch[]>()
  const [searchError, setSearchError] = useState<string>()
  const [isSearching, setIsSearching] = useState(false)

  async function findCandidates(): Promise<void> {
    if (displayName.trim().length < 2) return

    setIsSearching(true)
    setSearchError(undefined)

    try {
      setCandidates(await searchAuthorCandidates(displayName.trim()))
    } catch (error) {
      // A network/server failure is not "no matching authors" — showing it as
      // one would make the user believe an author search actually ran.
      setCandidates(undefined)
      setSearchError(describeError(error))
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="author-row">
      <TextField
        id={`correction-author-name-${field.name}`}
        label="Імʼя"
        autoComplete="off"
        value={displayName}
        hint={
          isExisting
            ? 'Наявний автор із каталогу — перейменувати його тут не можна.'
            : 'Буде створено нового автора.'
        }
        onChange={(event) => {
          const name = event.target.value

          setDisplayName(name)
          // Typing a name always means "different/new author": R10 forbids
          // renaming an existing global Author through this list, so this
          // switches the row away from `authorId` rather than editing it.
          field.onChange({ name, role: author.role })
        }}
      />

      {!isExisting && (
        <TextField
          id={`correction-author-name-latin-${field.name}`}
          label="Латиницею (необовʼязково)"
          value={author.nameLatin ?? ''}
          onChange={(event) => {
            const trimmed = event.target.value.trim()

            field.onChange({ ...author, nameLatin: trimmed === '' ? null : trimmed })
          }}
        />
      )}

      <SelectField
        id={`correction-author-role-${field.name}`}
        label="Роль"
        value={author.role ?? 'AUTHOR'}
        onChange={(event) => {
          field.onChange({ ...author, role: authorRoleSchema.parse(event.target.value) })
        }}
      >
        {AUTHOR_ROLE.map((role: AuthorRole) => (
          <option key={role} value={role}>
            {AUTHOR_ROLE_LABELS[role]}
          </option>
        ))}
      </SelectField>

      <div className="person__actions">
        <button
          type="button"
          className="button--ghost"
          disabled={onMoveUp === undefined}
          onClick={onMoveUp}
        >
          Вгору
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={onMoveDown === undefined}
          onClick={onMoveDown}
        >
          Вниз
        </button>
        <button
          type="button"
          className="button--ghost"
          disabled={isSearching}
          onClick={() => void findCandidates()}
        >
          {isSearching ? 'Шукаю…' : 'Чи є такий уже в каталозі?'}
        </button>
        {canRemove && (
          <button type="button" className="button--ghost" onClick={onRemove}>
            Прибрати
          </button>
        )}
      </div>

      {searchError !== undefined && (
        <AuthorSearchError message={searchError} onRetry={() => void findCandidates()} />
      )}

      {candidates !== undefined && (
        <AuthorCandidates
          candidates={candidates}
          onSelect={(candidate) => {
            setDisplayName(candidate.name)
            field.onChange({ authorId: candidate.id, role: author.role })
            setCandidates(undefined)
          }}
        />
      )}
    </div>
  )
}
