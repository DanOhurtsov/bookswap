'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  CATALOG_LIMITS,
  catalogQuerySchema,
  isValidIsbn13,
  normalizeIsbn13,
  workDetailResponseSchema,
  type AddSearchEditionItem,
  type AddSearchExternalItem,
  type AddSearchExternalResponse,
  type AddSearchResponse,
  type CatalogQuery,
  type CopyEntryMethod,
  type QuickAddResponse,
  type SearchPageSize,
} from '@bookswap/shared'
import { SearchIcon } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { apiRequest } from '@/app/lib/api'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { askedFor, readSearchAddress, searchHref } from '@/app/lib/search-page'
import { useKeyedRequest, type KeyedState } from '@/app/lib/use-keyed-request'
import { useSession } from '@/app/lib/use-session'
import { TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { Button } from '@/components/ui/button'
import {
  lookupIsbn,
  searchAddExternal,
  searchAddItems,
  suggestAddExternal,
  suggestAddItems,
} from '../api/add-search'
import { loadBarcodeScannerPanel } from '../lib/load-barcode-scanner-panel'
import {
  AUTO_EXTERNAL_MIN_CHARS,
  AUTO_LOCAL_MIN_CHARS,
  AUTO_PARAM,
  normalizeQuery,
} from '../model/auto-search'
import {
  IDLE_EXTERNAL_SEARCH,
  externalSearchBlind,
  externalSearchReady,
  externalSearchSettled,
  visibleSpellingSuggestion,
  type ExternalSearchState,
} from '../model/external-search-state'
import { externalIdentities, externalTarget } from '../model/external-target'
import { lookupCardIsRedundant } from '../model/lookup-card'
import { manualInitialFrom } from '../model/manual-form'
import { searchPageView } from '../model/search-page-view'
import { useAutoSearch } from '../model/use-auto-search'
import { useExternalSearch } from '../model/use-external-search'
import { useQuickAdd } from '../model/use-quick-add'
import { CopySettingsSheet } from './CopySettingsSheet'
import { EditionResultCard } from './EditionResultCard'
import { ExternalEditionCard } from './ExternalEditionCard'
import { ExternalSearchStatus } from './ExternalSearchStatus'
import { ExternalWorkCard } from './ExternalWorkCard'
import { LookupAddCard } from './LookupAddCard'
import { ManualAddForm } from './ManualAddForm'
import { QuickAddNotice } from './QuickAddNotice'
import {
  booksClass,
  emptyClass,
  ledeClass,
  pageClass,
  pendingStatusClass,
  searchingStatusClass,
} from './screen-styles'
import { SearchPagination } from './SearchPagination'
import { SpellingSuggestion } from './SpellingSuggestion'
import { WorkResultCard } from './WorkResultCard'

/**
 * Bundle-split boundary (§9): `next/dynamic` keeps the scanner panel — and its lazy `@zxing/*` import —
 * out of the initial `/catalog/new` chunk graph. The loader lives in its own module so tests can mock it.
 */
const BarcodeScannerPanel = dynamic(loadBarcodeScannerPanel, { ssr: false })

/** Ключ «що зараз в адресі»: режим і запит. Адреса, яку ми самі щойно записали, не скидає поле. */
function addressKey(auto: boolean, query: string): string {
  return `${auto ? 'auto' : 'full'}\u0000${query}`
}

/**
 * Адреса автопідказок: `auto=1` і перша сторінка. Окремий режим адреси, а не виконаний повний пошук —
 * тому й `replace`, а не `push`: підказки не засмічують історію.
 */
function autoHref(parameters: URLSearchParams, query: string, pageSize: SearchPageSize): string {
  return `${searchHref('/catalog/new', parameters, { q: query, page: 1, pageSize }, [AUTO_PARAM])}&${AUTO_PARAM}=1`
}

/** Адреса без запиту: поле спорожніло, підказки зникають. */
function clearedHref(parameters: URLSearchParams): string {
  const next = new URLSearchParams(parameters)

  for (const key of ['q', 'page', 'pageSize', AUTO_PARAM]) next.delete(key)

  const rest = next.toString()

  return rest === '' ? '/catalog/new' : `/catalog/new?${rest}`
}

/** Ідентичності видання: усі вказують на один слот додавання (див. `QuickAddSlot`). */
function identitiesOf(item: AddSearchEditionItem): string[] {
  return [
    `edition:${item.edition.id}`,
    ...(item.edition.isbn13 === null ? [] : [`isbn:${item.edition.isbn13}`]),
  ]
}

/**
 * Єдиний вхід у додавання книжки (docs/plan/fast-book-add.md, §2): пошук за назвою, автором або ISBN;
 * сканування лише підставляє ISBN у той самий пошук і нічого не створює.
 *
 * Стан пошуку — запит, сторінка, розмір — живе в адресі (пряме посилання, «назад» і перезавантаження
 * відновлюють список). Додавання нічого в адресі не змінює: після успіху користувач лишається в тих
 * самих результатах, на тій самій сторінці й позиції прокрутки.
 */
export function AddBookScreen() {
  const router = useRouter()
  const parameters = useSearchParams()
  const { state: session } = useSession()
  const address = readSearchAddress(parameters)
  /** Адреса в режимі автопідказок: `q` тоді — текст підказок, а не виконаний повний пошук. */
  const autoMode = parameters.get(AUTO_PARAM) === '1'
  const query = address.q.trim()
  const urlQuery = normalizeQuery(address.q)
  /** Повний пошук: лише з виконаного запиту, ніколи з чернетки. */
  const enabled = !autoMode && query.length >= CATALOG_LIMITS.queryMin
  const autoActive = autoMode && urlQuery.length >= AUTO_LOCAL_MIN_CHARS
  const showResults = enabled || autoActive
  /** «Шукати» на незмінному запиті — це запит шукати ЩЕ РАЗ (так само повторюється невдалий пошук). */
  const [refresh, setRefresh] = useState(0)
  const searchKey = `${String(refresh)}\u0000${askedFor(query, address.page, address.pageSize)}`
  const [scannedQuery, setScannedQuery] = useState<string>()
  const [scannerResetToken, setScannerResetToken] = useState(0)
  const entryMethod: CopyEntryMethod = scannedQuery === address.q ? 'BARCODE' : 'MANUAL'
  const [added, setAdded] = useState<QuickAddResponse>()
  const [settings, setSettings] = useState<{ target: QuickAddResponse; open: boolean }>()

  // Ручне додавання: окремий вигляд тієї самої сторінки. `workId` — «Уточнити видання» наявного твору.
  const presetWorkId = parameters.get('workId')
  const manualMode = parameters.get('mode') === 'manual' || presetWorkId !== null
  /** Кожна нова форма — новий намір (і новий слот додавання): після успіху можна додати наступну. */
  const [manualKey, setManualKey] = useState(0)
  const presetWork = useKeyedRequest(
    manualMode && presetWorkId !== null ? `work:${presetWorkId}` : undefined,
    (signal) =>
      apiRequest(`/works/${encodeURIComponent(presetWorkId ?? '')}`, {
        schema: workDetailResponseSchema,
        signal,
      }),
  )

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<CatalogQuery>({
    resolver: zodResolver(catalogQuerySchema),
    // Не `values`: адреса, яку пише сам автопошук, не має затирати те, що людина друкує далі.
    defaultValues: { q: address.q },
  })
  const draft = useWatch({ control, name: 'q' })
  /** Що в адресі записали МИ; зміна адреси на інше — це Back/Forward чи сканер, і поле слідує за нею. */
  const ownAddress = useRef(addressKey(autoMode, address.q))
  const auto = useAutoSearch({
    draft,
    urlQuery,
    autoMode,
    onSuggest: (text) => {
      // Повний пошук цього тексту вже запущено нами (клік по підказці), а адреса ще не встигла змінитись.
      if (ownAddress.current === addressKey(false, text)) return

      ownAddress.current = addressKey(true, text)
      router.replace(autoHref(parameters, text, address.pageSize), { scroll: false })
    },
    onClear: () => {
      ownAddress.current = addressKey(false, '')
      router.replace(clearedHref(parameters), { scroll: false })
    },
    onExact: (isbn13) => {
      ownAddress.current = addressKey(false, isbn13)
      router.replace(
        searchHref('/catalog/new', parameters, { q: isbn13, page: 1, pageSize: address.pageSize }, [
          AUTO_PARAM,
        ]),
        { scroll: false },
      )
    },
  })
  const restoreAuto = auto.restore

  useEffect(() => {
    const key = addressKey(autoMode, address.q)

    if (key === ownAddress.current) return

    ownAddress.current = key
    setValue('q', address.q)
    restoreAuto(autoMode ? normalizeQuery(address.q) : undefined)
  }, [autoMode, address.q, setValue, restoreAuto])

  const userId = session.status === 'authenticated' ? session.user.id : ''
  const quick = useQuickAdd({ userId, onAdded: setAdded })
  const request = useKeyedRequest(
    autoActive ? `auto\u0000${urlQuery}` : enabled ? searchKey : undefined,
    (signal) =>
      autoActive
        ? suggestAddItems(urlQuery, signal)
        : searchAddItems(query, address.page, address.pageSize, signal),
  )
  // Зовнішня половина повного пошуку: незалежний запит, місцеві результати його не чекають. Вона
  // живе лише від ВИКОНАНОГО запиту: чернетка її не запускає, а режим підказок вимикає (запит
  // скасовується, дочитування припиняється).
  const externalAnswer = useExternalSearch<AddSearchExternalItem>(
    enabled ? query : '',
    address.page,
    address.pageSize,
    refresh,
    searchAddExternal,
  )
  // Зовнішні підказки: один запит на текст, без дочитування й без повторів — наступний лише від нового тексту.
  const autoExternalAsked =
    autoActive &&
    urlQuery.length >= AUTO_EXTERNAL_MIN_CHARS &&
    !isValidIsbn13(urlQuery) &&
    auto.externalAsked === urlQuery
  const autoExternal = useKeyedRequest(
    autoExternalAsked ? `auto-external\u0000${urlQuery}` : undefined,
    (signal) => suggestAddExternal(urlQuery, signal),
  )
  // Пошук за ISBN: точний збіг у зовнішніх джерелах, коли в нашому каталозі такого видання ще немає.
  const isbn = !autoMode && isValidIsbn13(query) ? normalizeIsbn13(query) : undefined
  const lookup = useKeyedRequest(
    isbn !== undefined && address.page === 1 ? `${String(refresh)}\u0000isbn:${isbn}` : undefined,
    (signal) => lookupIsbn(isbn ?? '', signal),
  )
  // Підказки не стрибають: поки йде новий запит, попередній список лишається й замінюється разом, а не по картці.
  const [staleLocal, setStaleLocal] = useState<AddSearchResponse>()
  const fresh = request.status === 'ready' ? request.value : undefined

  if (autoActive && fresh !== undefined && fresh !== staleLocal) setStaleLocal(fresh)
  else if (!autoActive && staleLocal !== undefined) setStaleLocal(undefined)

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  // `page`/`pageSize` написано нісенітницю: показуємо першу сторінку й виправляємо адресу (`replace`).
  const addressValid = address.valid

  useEffect(() => {
    if (!addressValid && address.q !== '') {
      router.replace(
        searchHref('/catalog/new', parameters, { q: address.q, page: 1, pageSize: 10 }),
      )
    }
  }, [addressValid, address.q, parameters, router])

  if (session.status === 'loading') {
    return (
      <main className={pageClass}>
        <h1>Додати книжку</h1>
        <p className={pendingStatusClass}>Перевіряю сесію…</p>
      </main>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <main className={pageClass}>
        <h1>Додати книжку</h1>
        <p className={pendingStatusClass}>Потрібен вхід. Переадресовую…</p>
      </main>
    )
  }

  const external: ExternalSearchState<AddSearchExternalItem> = autoMode
    ? autoExternalView(urlQuery, autoExternalAsked, autoExternal)
    : externalAnswer
  const response = fresh ?? (autoActive ? staleLocal : undefined)
  const items = response?.items ?? []
  // Яка підказка і чи показувати — `visibleSpellingSuggestion`: зовнішня половина має останнє слово,
  // а стара зникає, щойно текст у полі перестає збігатися з тим, для якого її обчислено.
  const spellingText = visibleSpellingSuggestion(
    auto.normalized,
    response?.spellingSuggestion,
    external,
    normalizeQuery,
  )
  const externalItems = external.status === 'ready' ? external.results : []
  // Один список: картка точного ISBN-пошуку не дублює видання, яке вже є серед місцевих чи зовнішніх результатів.
  const redundantLookup = isbn !== undefined && lookupCardIsRedundant(isbn, items, externalItems)
  const lookupCard =
    lookup.status === 'ready' && response !== undefined && !redundantLookup
      ? lookup.value
      : undefined
  const view = searchPageView({
    page: address.page,
    local: { ready: response !== undefined, hasMore: response?.hasMore ?? false },
    // Картка lookup — теж рядок списку: від неї залежить, чи поточна сторінка не порожня.
    rowCount: items.length + externalItems.length + (lookupCard === undefined ? 0 : 1),
    external,
  })
  // Показане для ІНШОГО тексту (чернетка ще не в адресі) чи ще не завершене — «нічого не знайдено» не кажемо.
  const finished =
    fresh !== undefined &&
    externalSearchSettled(external) &&
    lookup.status !== 'loading' &&
    !(autoActive && auto.localPending)
  const externalUnavailable =
    autoActive &&
    (external.status === 'failed' ||
      (external.status === 'ready' && external.sources.some((report) => report.status !== 'OK')))
  const nothing = items.length === 0 && externalItems.length === 0 && lookupCard === undefined

  const manualParameters = new URLSearchParams({ mode: 'manual' })

  if (isbn !== undefined) manualParameters.set('isbn', isbn)
  else if (autoActive) manualParameters.set('title', urlQuery)
  else if (enabled) manualParameters.set('title', query)

  const manualHref = `/catalog/new?${manualParameters.toString()}`

  function renderEdition(item: AddSearchEditionItem) {
    const identities = identitiesOf(item)

    return (
      <EditionResultCard
        key={item.key}
        item={item}
        slot={quick.slotFor(identities)}
        onAdd={(additional) => {
          quick.add({
            identities,
            entryMethod,
            additional,
            target: { kind: 'EXISTING_EDITION', editionId: item.edition.id },
          })
        }}
        onRetry={() => {
          quick.retry(identities)
        }}
      />
    )
  }

  /** Явний повний пошук: відкладені запуски знімаються, і виконується рівно один пошук. */
  function runFullSearch(text: string): void {
    auto.cancel()
    setScannedQuery(undefined)
    setScannerResetToken((token) => token + 1)

    const next = { q: normalizeQuery(text), page: 1, pageSize: address.pageSize }

    if (!autoMode && next.q === urlQuery && address.page === 1) setRefresh((count) => count + 1)

    ownAddress.current = addressKey(false, next.q)
    router.push(searchHref('/catalog/new', parameters, next, [AUTO_PARAM]))
  }

  function submit({ q }: CatalogQuery): void {
    runFullSearch(q)
  }

  if (manualMode) {
    const identities = [`manual:${String(manualKey)}`]
    const presetTitle = presetWork.status === 'ready' ? presetWork.value.work.title : undefined
    const waitingForWork = presetWorkId !== null && presetWork.status !== 'ready'

    return (
      <main className={pageClass}>
        <h1>Додати книжку вручну</h1>
        <p className={ledeClass}>
          Обов’язкова лише назва. Решту можна не знати — її можна уточнити пізніше.
        </p>
        <p>
          <Link
            href={searchHref(
              '/catalog/new',
              parameters,
              { q: address.q, page: 1, pageSize: address.pageSize },
              ['mode', 'workId', 'title', 'isbn', 'author', 'firstPubYear'],
            )}
          >
            ← До пошуку
          </Link>
        </p>

        <QuickAddNotice
          added={added}
          onCustomize={() => {
            if (added !== undefined) setSettings({ target: added, open: true })
          }}
        />

        {presetWork.status === 'error' && (
          <FormStatus error={new Error(describeAddBookError(presetWork.error))} />
        )}
        {waitingForWork && presetWork.status === 'loading' && (
          <p className={pendingStatusClass}>Читаю твір…</p>
        )}

        {!waitingForWork && (
          <ManualAddForm
            key={manualKey}
            initial={manualInitialFrom(parameters)}
            {...(presetWorkId !== null && presetTitle !== undefined
              ? { presetWork: { id: presetWorkId, title: presetTitle } }
              : {})}
            slot={quick.slotFor(identities)}
            onSubmit={(target) => {
              quick.add({ identities, entryMethod: 'MANUAL', target })
            }}
            onRetry={() => {
              quick.retry(identities)
            }}
            onUseExistingEdition={(editionId) => {
              quick.add({
                identities,
                entryMethod: 'MANUAL',
                target: { kind: 'EXISTING_EDITION', editionId },
              })
            }}
            onAddAnother={() => {
              setAdded(undefined)
              setManualKey((key) => key + 1)
            }}
          />
        )}

        {settings !== undefined && (
          <CopySettingsSheet
            key={settings.target.copy.id}
            open={settings.open}
            added={settings.target}
            libraryVisibility={session.user.libraryVisibility}
            onClose={() => {
              setSettings((current) =>
                current === undefined ? current : { ...current, open: false },
              )
            }}
          />
        )}
      </main>
    )
  }

  return (
    <main className={pageClass}>
      <h1>Додати книжку</h1>
      <p className={ledeClass}>
        Знайдіть конкретне видання й додайте його до бібліотеки одним натисканням.
      </p>

      {/* Інпут, «Шукати» і сканер — один ряд: `BarcodeScannerPanel` сидить у тій самій сітці (`display: contents`). */}
      <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 gap-y-3">
        <form
          className="flex items-end gap-2 [&_.field]:relative [&_.field]:min-w-0 [&_.field]:flex-auto **:[[role=alert]]:absolute **:[[role=alert]]:top-[calc(100%+0.35rem)]"
          onSubmit={(event) => void handleSubmit(submit)(event)}
          noValidate
        >
          <TextField
            id="search-query"
            label="Назва, автор або ISBN"
            autoComplete="off"
            hint="Мінімум два символи."
            error={errors.q?.message}
            {...register('q')}
            {...auto.composition}
          />

          <Button
            type="submit"
            size="icon"
            className="size-11 cursor-pointer"
            aria-label="Шукати"
            title="Шукати"
          >
            <SearchIcon aria-hidden="true" className="size-4" />
          </Button>
        </form>

        <BarcodeScannerPanel
          key={scannerResetToken}
          onValidIsbn={(isbn) => {
            setScannedQuery(isbn)
            auto.cancel()
            router.push(
              searchHref(
                '/catalog/new',
                parameters,
                { q: isbn, page: 1, pageSize: address.pageSize },
                [AUTO_PARAM],
              ),
            )
          }}
        />

        {spellingText !== undefined && (
          <SpellingSuggestion
            text={spellingText}
            onPick={(text) => {
              setValue('q', text)
              runFullSearch(text)
            }}
          />
        )}
      </div>

      {/* Завжди доступне — також коли зовнішні джерела не відповіли: ручний шлях ні від чого не залежить. */}

      <QuickAddNotice
        added={added}
        onCustomize={() => {
          if (added !== undefined) setSettings({ target: added, open: true })
        }}
      />

      {showResults && (
        <>
          {request.status === 'error' && (
            <FormStatus error={new Error(describeAddBookError(request.error))} />
          )}

          {lookupCard !== undefined && isbn !== undefined && (
            <ul className={booksClass}>
              <LookupAddCard
                isbn={isbn}
                lookup={lookupCard}
                slot={quick.slotFor([`isbn:${isbn}`])}
                onAdd={(additional) => {
                  quick.add({
                    identities: [`isbn:${isbn}`],
                    entryMethod,
                    additional,
                    target: { kind: 'EXTERNAL_EDITION', isbn13: isbn },
                  })
                }}
                onRetry={() => {
                  quick.retry([`isbn:${isbn}`])
                }}
              />
            </ul>
          )}

          {(items.length > 0 || externalItems.length > 0) && (
            <ul className={booksClass}>
              {items.map((item) =>
                item.kind === 'WORK' ? (
                  <WorkResultCard key={item.key} item={item} />
                ) : (
                  renderEdition(item)
                ),
              )}
              {externalItems.map((item) => {
                if (item.kind === 'EDITION') return renderEdition(item)

                const target = externalTarget(item.result)

                if (target === undefined)
                  return <ExternalWorkCard key={item.key} result={item.result} />

                const identities = externalIdentities(item.result)

                return (
                  <ExternalEditionCard
                    key={item.key}
                    result={item.result}
                    slot={quick.slotFor(identities)}
                    onAdd={(additional) => {
                      quick.add({ identities, entryMethod, additional, target })
                    }}
                    onRetry={() => {
                      quick.retry(identities)
                    }}
                  />
                )
              })}
            </ul>
          )}

          <ExternalSearchStatus
            state={external}
            localLoading={request.status === 'loading' || (autoActive && auto.localPending)}
          />

          {lookup.status === 'error' && !redundantLookup && response !== undefined && (
            <p className={pendingStatusClass}>{describeAddBookError(lookup.error)}</p>
          )}

          {externalUnavailable && !(finished && nothing) && (
            <p className={searchingStatusClass}>Зовнішній пошук тимчасово недоступний.</p>
          )}

          {finished && nothing && (autoActive || address.page === 1) && (
            <p className={emptyClass}>
              {externalSearchBlind(external)
                ? 'У BookSwap нічого схожого немає, а зовнішні каталоги не відповіли — чи є там ця книжка, невідомо.'
                : autoActive && external.status === 'idle'
                  ? 'У нашому каталозі нічого схожого немає. Додайте символ або натисніть «Шукати» — тоді пошук піде й у зовнішні каталоги.'
                  : 'Нічого схожого не знайшлося.'}
            </p>
          )}

          {enabled && finished && nothing && address.page > 1 && (
            <p className={emptyClass}>На цій сторінці результатів немає.</p>
          )}

          {autoActive && fresh !== undefined && (
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => {
                runFullSearch(urlQuery)
              }}
            >
              Показати всі результати
            </Button>
          )}

          {enabled && request.status !== 'idle' && (
            <SearchPagination
              page={address.page}
              pageSize={address.pageSize}
              next={view.next}
              currentHasRows={view.currentHasRows}
              hrefFor={(target) =>
                searchHref('/catalog/new', parameters, { q: address.q, ...target })
              }
              onPageSizeChange={(pageSize) => {
                router.push(
                  searchHref('/catalog/new', parameters, { q: address.q, page: 1, pageSize }),
                )
              }}
            />
          )}
        </>
      )}
      <p className="text-[1rem] text-(--bookswap-muted)">
        {showResults
          ? 'Не знайшли потрібну книжку?'
          : 'Щоб шукати, введіть назву, автора або ISBN.'}{' '}
        <Link href={manualHref} className="hover:underline text-(--bookswap-accent)">
          Додати вручну
        </Link>
      </p>

      {settings !== undefined && (
        <CopySettingsSheet
          key={settings.target.copy.id}
          open={settings.open}
          added={settings.target}
          libraryVisibility={session.user.libraryVisibility}
          onClose={() => {
            setSettings((current) =>
              current === undefined ? current : { ...current, open: false },
            )
          }}
        />
      )}
    </main>
  )
}

/**
 * Зовнішня половина підказок у тому самому вигляді, що й повного пошуку, — тож «нічого не знайдено»,
 * «чекаю» й «джерело не відповіло» рахуються ТИМИ САМИМИ функціями. До порогу — `idle`; поки текст ще
 * не питали (пауза) чи запит триває — `loading`: порожній список тоді означає «ще ні», а не «немає».
 */
function autoExternalView(
  urlQuery: string,
  asked: boolean,
  answer: KeyedState<AddSearchExternalResponse>,
): ExternalSearchState<AddSearchExternalItem> {
  if (urlQuery.length < AUTO_EXTERNAL_MIN_CHARS || isValidIsbn13(urlQuery)) {
    return IDLE_EXTERNAL_SEARCH
  }

  if (!asked || answer.status === 'idle' || answer.status === 'loading') {
    return { status: 'loading' }
  }

  if (answer.status === 'error') {
    return { status: 'failed', message: describeAddBookError(answer.error) }
  }

  return externalSearchReady({
    results: answer.value.items,
    sources: answer.value.sources,
    page: answer.value.page,
    pageSize: answer.value.pageSize,
    more: answer.value.more,
    complete: answer.value.complete,
    ...(answer.value.spellingSuggestion === undefined
      ? {}
      : { spellingSuggestion: answer.value.spellingSuggestion }),
  })
}
