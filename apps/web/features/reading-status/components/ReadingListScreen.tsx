'use client'

import Link from 'next/link'
import type { ReadingListItem } from '@bookswap/shared'
import { AuthorLine, Chip } from '@/components/BookParts'
import { ToggleTab, ToggleTabs } from '@/components/ui/tabs'
import { READING_STATUS_LABELS, WAS_BORROWED_LABEL } from '@/app/lib/labels'
import { useReadingList, type ReadingListFilter } from '../model/use-reading-list'

const FILTERS: readonly { value: ReadingListFilter; label: string }[] = [
  { value: undefined, label: 'Усі' },
  { value: 'READING', label: READING_STATUS_LABELS.READING },
  { value: 'READ', label: READING_STATUS_LABELS.READ },
]

const EMPTY_TEXT: Readonly<Record<'ALL' | 'READING' | 'READ', string>> = {
  ALL: 'Тут поки порожньо. Позначте твір «Читаю» або «Прочитано» на його сторінці.',
  READING: 'Зараз ви нічого не читаєте.',
  READ: 'Прочитаних творів поки немає.',
}

/**
 * Stage 10 (10j.2): the viewer's private reading list — only `READING` and `READ` (T13). There is
 * no list of works that are "not read": that would be the whole catalog.
 */
export function ReadingListScreen() {
  const { filter, setFilter, state, more, reload, loadMore } = useReadingList()

  return (
    <>
      <p className="lede">Список бачите лише ви. Статус змінюється на сторінці твору.</p>

      <nav className="actions" aria-label="Фільтр списку читання">
        <ToggleTabs>
          {FILTERS.map((option) => (
            <ToggleTab
              key={option.label}
              pressed={filter === option.value}
              onClick={() => {
                if (filter !== option.value) setFilter(option.value)
              }}
            >
              {option.label}
            </ToggleTab>
          ))}
        </ToggleTabs>
      </nav>

      {state.status === 'loading' && <p className="status status--pending">Завантажую…</p>}

      {state.status === 'error' && (
        <div role="alert">
          <p className="status status--error">{state.message}</p>
          <button type="button" onClick={reload}>
            Спробувати ще раз
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <p className="empty">{EMPTY_TEXT[filter ?? 'ALL']}</p>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <ul className="books">
          {state.items.map((item) => (
            <ReadingListRow key={item.work.id} item={item} />
          ))}
        </ul>
      )}

      {state.status === 'ready' && more.status === 'error' && (
        <div role="alert">
          <p className="status status--error">Не вдалося завантажити ще: {more.message}</p>
        </div>
      )}

      {state.status === 'ready' && state.nextCursor !== null && (
        <p className="form__aside">
          <button
            type="button"
            className="button--ghost"
            disabled={more.status === 'loading'}
            onClick={() => void loadMore()}
          >
            {more.status === 'loading'
              ? 'Завантажую…'
              : more.status === 'error'
                ? 'Спробувати ще раз'
                : 'Показати ще'}
          </button>
        </p>
      )}
    </>
  )
}

function ReadingListRow({ item }: { item: ReadingListItem }) {
  return (
    <li className="book">
      <Link className="book__title" href={`/works/${encodeURIComponent(item.work.id)}`}>
        {item.work.title}
      </Link>
      <AuthorLine authors={item.authors} />
      <div className="chips">
        <Chip>{READING_STATUS_LABELS[item.status]}</Chip>
        {item.wasBorrowed && <Chip>{WAS_BORROWED_LABEL}</Chip>}
      </div>
    </li>
  )
}
