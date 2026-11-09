'use client'

import Link from 'next/link'
import { useRef } from 'react'
import { Menu } from '@base-ui/react/menu'
import { BookOpenIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { shownStatusLabel, type ShownStatus } from '../model/loan-status'
import type { LoansFilters } from '../model/loans-address'
import { useSearchDraft } from '../model/use-search-draft'

/** The canvas `.btn-primary`: 44 px, 15 px semibold, the brand green in both themes (as BS-147). */
export const LOANS_CTA =
  'h-11 gap-2 px-[18px] text-[15px] font-semibold bg-(--canvas-cta-bg) text-(--canvas-on-cta) hover:bg-(--canvas-cta-hover) active:bg-(--canvas-cta-hover) aria-expanded:bg-(--canvas-cta-hover) aria-expanded:text-(--canvas-on-cta)'

type StatusOption = { value: ShownStatus | ''; label: string }

type LoansToolbarProps = {
  filters: LoansFilters
  /** The statuses this tab can show (PO, 05.11.2026). */
  statuses: readonly ShownStatus[]
  onFiltersChange: (filters: Partial<LoansFilters>) => void
}

/**
 * Search, the status and «Нова позика» above the list. Both filters act on the open tab only and
 * live in its address; the list under them follows the address, not this form.
 */
export function LoansToolbar({ filters, statuses, onFiltersChange }: LoansToolbarProps) {
  const options: StatusOption[] = [
    { value: '', label: 'Усі статуси' },
    ...statuses.map((status) => ({ value: status, label: shownStatusLabel(status) })),
  ]

  return (
    <div className="loans-toolbar">
      <LoansSearch
        applied={filters.query}
        onSearch={(query) => {
          onFiltersChange({ query })
        }}
      />
      <div className="loans-toolbar__status">
        <label htmlFor="loans-status" className="sr-only">
          Статус
        </label>
        <Select
          value={options.find((option) => option.value === (filters.status ?? '')) ?? null}
          isItemEqualToValue={(one: StatusOption, other: StatusOption) => one.value === other.value}
          onValueChange={(option: StatusOption | null) => {
            if (option !== null)
              onFiltersChange({ status: option.value === '' ? null : option.value })
          }}
        >
          <SelectTrigger id="loans-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NewLoanMenu />
    </div>
  )
}

function LoansSearch({
  applied,
  onSearch,
}: {
  applied: string
  onSearch: (query: string) => void
}) {
  const search = useSearchDraft(applied, onSearch)
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className="loans-search">
      <SearchIcon aria-hidden="true" className="loans-search__icon" />
      <label htmlFor="loans-search" className="sr-only">
        Пошук позик
      </label>
      <input
        ref={input}
        id="loans-search"
        type="search"
        className="loans-search__input"
        placeholder="Назва, автор або людина"
        autoComplete="off"
        value={search.draft}
        onChange={(event) => {
          search.change(event.target.value)
        }}
      />
      {search.draft !== '' && (
        <button
          type="button"
          data-ui="button"
          className="loans-search__clear"
          aria-label="Очистити пошук"
          onClick={() => {
            search.change('')
            input.current?.focus()
          }}
        >
          <XIcon aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/**
 * «Нова позика» starts one of the flows that already exist (PO, 05.11.2026). Each of them begins at a
 * book, so the menu only leads there: lending is recorded from the copy's menu in «Книжки» (to a
 * friend, or to a guest where that is on), borrowing is a request from a friend's copy found in the
 * catalog. Nothing is created here, so the button has no pending state of its own.
 */
export function NewLoanMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" className={LOANS_CTA} />}>
        <PlusIcon aria-hidden="true" className="size-[18px]" />
        Нова позика
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="loans-new-menu">
        <Menu.LinkItem render={<Link href="/library" />} className="loans-new-menu__item">
          <BookOpenIcon aria-hidden="true" />
          <span className="loans-new-menu__text">
            <span className="loans-new-menu__title">Позичити свою книжку</span>
            <span className="loans-new-menu__hint">Оберіть примірник у «Книжках»</span>
          </span>
        </Menu.LinkItem>
        <Menu.LinkItem render={<Link href="/catalog" />} className="loans-new-menu__item">
          <UsersIcon aria-hidden="true" />
          <span className="loans-new-menu__text">
            <span className="loans-new-menu__title">Попросити книжку в друга</span>
            <span className="loans-new-menu__hint">Знайдіть її в каталозі</span>
          </span>
        </Menu.LinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
