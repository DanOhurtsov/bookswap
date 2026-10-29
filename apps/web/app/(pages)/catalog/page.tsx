'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  CATALOG_DISCOVERY_AVAILABILITY,
  CATALOG_DISCOVERY_TRANSLATION,
  DEFAULT_SEARCH_PAGE_SIZE,
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
import { discoveryNextPage, useCatalogDiscovery } from '@/app/lib/use-catalog'
import { useSession } from '@/app/lib/use-session'
import { useGuestRedirect } from '@/app/lib/use-login-redirect'
import { FieldErrors, validate } from '@/app/lib/validation'
import { FormStatus } from '@/components/Form/FormStatus'
import { SelectField, TextField, labelledOptions } from '@/components/Form/FormFields'
import { LanguageSelect } from '@/components/Form/LanguageSelect'
import {
  LocalResultCard,
  ResultCardGrid,
  SearchPagination,
} from '@/features/catalog/add-book/index.client'
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

const SCOPE_OPTIONS = [
  { value: 'CIRCLE', label: 'Мої та друзів' },
  { value: 'ALL', label: 'Усіх користувачів' },
] as const

const AVAILABILITY_OPTIONS = labelledOptions(CATALOG_DISCOVERY_AVAILABILITY, AVAILABILITY_LABELS)
const TRANSLATION_OPTIONS = labelledOptions(CATALOG_DISCOVERY_TRANSLATION, TRANSLATION_LABELS)

/** The session guard: the search below needs the viewer, whose cached pages it reads. */
function CatalogDiscovery() {
  const { state: session } = useSession()

  useGuestRedirect(session.status)

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

  return <CatalogSearch viewerId={session.user.id} />
}

type CatalogSearchProps = { viewerId: string }

function CatalogSearch({ viewerId }: CatalogSearchProps) {
  const router = useRouter()
  const parameters = useSearchParams()
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
  const search = useCatalogDiscovery(
    { viewerId, query: submitted, pageSize, scope, filters, refresh },
    page,
  )

  function hrefFor(
    target: SearchAddress,
    targetScope = scope,
    targetFilters: DiscoveryFilters = filters,
  ): string {
    return discoveryHref(target, targetScope, targetFilters)
  }

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

      <SelectField
        id="catalog-scope"
        label="Показувати книжки"
        inline
        value={scope}
        options={SCOPE_OPTIONS}
        onValueChange={(nextScope) => {
          router.push(hrefFor({ q: submitted, page: 1, pageSize }, nextScope))
        }}
      />

      {scope === 'CIRCLE' && (
        <div className="search-filters">
          <SelectField
            id="catalog-availability"
            label="Доступність"
            inline
            value={filters.availability}
            options={AVAILABILITY_OPTIONS}
            onValueChange={(availability) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, { ...filters, availability }),
              )
            }}
          />
          {/* Only the languages the discovery API accepts (`DISCOVERY_LANGUAGES`), by name. */}
          <LanguageSelect
            id="catalog-language"
            label="Мова"
            inline
            emptyLabel="Будь-яка"
            codes={DISCOVERY_LANGUAGES}
            value={filters.language}
            onChange={(language) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, { ...filters, language }),
              )
            }}
          />
          <SelectField
            id="catalog-translation"
            label="Переклад"
            inline
            value={filters.translation}
            options={TRANSLATION_OPTIONS}
            onValueChange={(translation) => {
              router.push(
                hrefFor({ q: submitted, page: 1, pageSize }, scope, { ...filters, translation }),
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
        <ResultCardGrid>
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
        </ResultCardGrid>
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
          next={discoveryNextPage(page, response)}
          currentHasRows={(response?.results.length ?? 0) > 0}
          hrefFor={(target) => hrefFor({ q: submitted, ...target })}
          onPageSizeChange={(size) => {
            router.push(hrefFor({ q: submitted, page: 1, pageSize: size }))
          }}
        />
      )}

      <p className="form__aside">
        Не знайшли книжку?{' '}
        <Link href={`/catalog/new?q=${encodeURIComponent(submitted)}`} className="link-underline">
          Додати свою книжку
        </Link>
      </p>
    </Shell>
  )
}
