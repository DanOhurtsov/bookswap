'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  CATALOG_DISCOVERY_AVAILABILITY,
  CATALOG_DISCOVERY_TRANSLATION,
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  catalogQuerySchema,
  type CatalogDiscoveryScope,
} from '@bookswap/shared'
import {
  AVAILABILITY_LABELS,
  DISCOVERY_LANGUAGES,
  TRANSLATION_LABELS,
  discoveryHref,
  readDiscoveryFilters,
  type DiscoveryFilters,
} from '@/app/lib/discovery-filters'
import { readSearchAddress, type SearchAddress } from '@/app/lib/search-page'
import { useCatalogDiscovery } from '@/app/lib/use-catalog'
import { useSession } from '@/app/lib/use-session'
import { FieldErrors, validate } from '@/app/lib/validation'
import { FormStatus } from '@/components/Form/FormStatus'
import { TextField } from '@/components/Form/FormFields'
import { LocalResultCard, SearchPagination } from '@/features/catalog/add-book/index.client'
import { NetworkOwnerCopies } from '@/features/network/index.client'

export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <p className="status status--pending">Читаю запит…</p>
        </Shell>
      }
    >
      <CatalogDiscovery />
    </Suspense>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Доступні від друзів</h1>
      {children}
    </main>
  )
}

const MATCH_LABELS = {
  TITLE: 'збіг за назвою',
  AUTHOR: 'збіг за автором',
  ISBN: 'точний збіг за ISBN',
} as const

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <label className="search-pagination__size">
      {label}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function CatalogDiscovery() {
  const router = useRouter()
  const parameters = useSearchParams()
  const { state: session } = useSession()
  const address = readSearchAddress(parameters)
  const { q: submitted, page, pageSize } = address
  const rawScope = parameters.get('scope')
  const scope: CatalogDiscoveryScope = rawScope === 'ALL' ? 'ALL' : 'CIRCLE'
  const scopeValid = rawScope === null || rawScope === 'CIRCLE' || rawScope === 'ALL'
  const [query, setQuery] = useState(submitted)
  const [syncedWith, setSyncedWith] = useState(submitted)
  const [refresh, setRefresh] = useState(0)
  const [errors, setErrors] = useState<FieldErrors>({})
  const { filters, valid: filtersValid } = readDiscoveryFilters(parameters)
  const search = useCatalogDiscovery(submitted, page, pageSize, scope, filters, refresh)

  function hrefFor(
    target: SearchAddress,
    targetScope = scope,
    targetFilters: DiscoveryFilters = filters,
  ): string {
    return discoveryHref(target, targetScope, targetFilters)
  }

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (submitted !== syncedWith) {
    setSyncedWith(submitted)
    setQuery(submitted)
  }

  useEffect(() => {
    if (!address.valid || !scopeValid || !filtersValid) {
      router.replace(
        discoveryHref(
          { q: submitted, page: 1, pageSize: DEFAULT_SEARCH_PAGE_SIZE },
          scopeValid ? scope : 'CIRCLE',
          filters,
        ),
      )
    }
  }, [address.valid, scopeValid, filtersValid, scope, submitted, filters, router])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    // The circle browses without text; the legacy `ALL` scope still needs a query.
    const browse = scope === 'CIRCLE' && query.trim() === ''
    const parsed = browse
      ? { ok: true as const, data: { q: '' } }
      : validate(catalogQuerySchema, { q: query })

    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }

    setErrors({})

    if (parsed.data.q === submitted && page === 1) {
      setRefresh((current) => current + 1)
    } else {
      router.push(hrefFor({ q: parsed.data.q, page: 1, pageSize }))
    }
  }

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  const response = search.status === 'ready' ? search.response : undefined

  return (
    <Shell>
      <p className="lede">Фізичні книжки, які є вдома у вас або друзів. Текст — за бажанням.</p>

      <form className="search" onSubmit={submit} noValidate>
        <TextField
          id="catalog-query"
          label={
            scope === 'CIRCLE' ? 'Назва, автор або ISBN (необовʼязково)' : 'Назва, автор або ISBN'
          }
          name="q"
          autoComplete="off"
          hint="Мінімум два символи. Без тексту показуються всі книжки кола."
          value={query}
          error={errors.q ?? errors.form}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <button type="submit">Знайти</button>
      </form>

      <label className="search-pagination__size">
        Показувати книжки
        <select
          value={scope}
          onChange={(event) => {
            const nextScope = event.target.value === 'ALL' ? 'ALL' : 'CIRCLE'
            router.push(hrefFor({ q: submitted, page: 1, pageSize }, nextScope))
          }}
        >
          <option value="CIRCLE">Мої та друзів</option>
          <option value="ALL">Усіх користувачів</option>
        </select>
      </label>

      {scope === 'CIRCLE' && (
        <div className="search-filters">
          <FilterSelect
            label="Доступність"
            value={filters.availability}
            options={CATALOG_DISCOVERY_AVAILABILITY.map((value) => ({
              value,
              label: AVAILABILITY_LABELS[value],
            }))}
            onChange={(value) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, {
                  ...filters,
                  availability: value === 'ANY' ? 'ANY' : 'AVAILABLE',
                }),
              )
            }}
          />
          <FilterSelect
            label="Мова"
            value={filters.language}
            options={[
              { value: '', label: 'Будь-яка' },
              ...DISCOVERY_LANGUAGES.map((code) => ({ value: code, label: code })),
            ]}
            onChange={(value) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, {
                  ...filters,
                  language: value,
                }),
              )
            }}
          />
          <FilterSelect
            label="Переклад"
            value={filters.translation}
            options={CATALOG_DISCOVERY_TRANSLATION.map((value) => ({
              value,
              label: TRANSLATION_LABELS[value],
            }))}
            onChange={(value) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, {
                  ...filters,
                  translation: value === 'ORIGINAL' || value === 'TRANSLATED' ? value : 'ANY',
                }),
              )
            }}
          />
        </div>
      )}

      {scope === 'ALL' && (
        <p className="form__aside">
          Книжки інших користувачів видно, якщо їхня бібліотека публічна. Позичати можна після
          додавання власника в друзі.
        </p>
      )}

      {search.status === 'idle' && <p className="empty">Уведіть щонайменше два символи.</p>}
      {search.status === 'loading' && <p className="status status--pending">Шукаю…</p>}
      {search.status === 'error' && <FormStatus error={new Error(search.message)} />}

      {response !== undefined && response.results.length > 0 && (
        <ul className="books">
          {response.results.map((result) => (
            <LocalResultCard
              key={result.work.id}
              candidate={result}
              href={`/works/${result.work.id}`}
              note={MATCH_LABELS[result.matchedOn]}
              locations={result.locations}
              renderLocationActions={(location) => (
                <NetworkOwnerCopies
                  owner={location}
                  onRequested={() => setRefresh((current) => current + 1)}
                />
              )}
            />
          ))}
        </ul>
      )}

      {response !== undefined && response.results.length === 0 && (
        <p className="empty">
          {page > 1
            ? 'На цій сторінці книжок немає.'
            : scope === 'CIRCLE'
              ? 'Серед ваших книжок і книжок друзів доступних примірників не знайшлося.'
              : 'Серед доступних користувачам примірників нічого не знайшлося.'}
        </p>
      )}

      {search.status !== 'idle' && (
        <SearchPagination
          page={page}
          pageSize={pageSize}
          next={response?.hasMore === true && page < SEARCH_MAX_PAGE ? 'PROVEN' : 'NONE'}
          currentHasRows={(response?.results.length ?? 0) > 0}
          hrefFor={(target) => hrefFor({ q: submitted, ...target })}
          onPageSizeChange={(size) => {
            router.push(hrefFor({ q: submitted, page: 1, pageSize: size }))
          }}
        />
      )}

      <p className="form__aside">
        Не знайшли книжку?{' '}
        <Link href={`/catalog/new?q=${encodeURIComponent(submitted)}`}>Додати свою книжку</Link>
      </p>
      <p className="form__aside">
        <Link href="/library">Моя бібліотека</Link> · <Link href="/friends">Друзі</Link> ·{' '}
        <Link href="/">На головну</Link>
      </p>
    </Shell>
  )
}
