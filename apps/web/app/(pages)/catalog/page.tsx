'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  catalogSearchRequestSchema,
  type CatalogSearchResult,
  type ExternalSearchResult,
} from '@bookswap/shared'
import { useSession } from '@/app/lib/use-session'
import { FieldErrors, validate } from '@/app/lib/validation'
import { useCatalogSearch } from '@/app/lib/use-catalog'
import { FormStatus } from '@/components/Form/FormStatus'
import { TextField } from '@/components/Form/FormFields'
import {
  ExternalResultCard,
  ExternalSearchStatus,
  LocalResultCard,
  buildUnifiedResults,
  externalSearchBlind,
  externalSearchSettled,
  stashExternalSelection,
  useExternalSearch,
} from '@/features/catalog/add-book/index.client'

/**
 * §6.3, кроки 1–2: людина вводить назву або ISBN і бачить «Можливо, це одна з
 * цих?» — разом із виданнями, бо саме на них вона впізнає своє.
 *
 * Це найважливіший екран сервісу: він прибирає більшість дублікатів ще до їхньої
 * появи. Тому кнопка «Створити новий твір» стоїть ПІД результатами, а не поруч
 * із пошуком — спершу подивись, чи його вже завели.
 *
 * Пошук тут такий самий, як у майстрі додавання: один список, у якому власний
 * каталог і зовнішні каталоги впорядковані за релевантністю. Правила
 * впорядкування, дедуплікація, картки й рядок стану джерел — ті самі модулі
 * (`@/features/catalog/add-book`), а не друга їх копія: два екрани, що
 * відповідають на одне питання по-різному, рано чи пізно розійдуться.
 */
export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <p className="status status--pending">Читаю запит…</p>
        </Shell>
      }
    >
      <CatalogSearch />
    </Suspense>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Каталог</h1>
      {children}
    </main>
  )
}

const MATCH_LABELS: Readonly<Record<CatalogSearchResult['matchedOn'], string>> = {
  TITLE: 'збіг за назвою',
  AUTHOR: 'збіг за автором',
  ISBN: 'точний збіг за ISBN',
}

function CatalogSearch() {
  const router = useRouter()
  const parameters = useSearchParams()
  const { state: session } = useSession()

  // Запит живе в URL: посилання на пошук можна надіслати, і кнопка «назад»
  // працює так, як людина очікує.
  const submitted = parameters.get('q') ?? ''
  const [query, setQuery] = useState(submitted)
  const [syncedWith, setSyncedWith] = useState(submitted)
  const [errors, setErrors] = useState<FieldErrors>({})
  const search = useCatalogSearch(submitted)
  const external = useExternalSearch(submitted)

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  // Кнопка «назад» міняє `?q=` — поле має піти за нею. Підлаштування стану під
  // час рендеру, а не в ефекті: ефект дав би зайвий прохід рендеру з розʼїханими
  // полем і адресою, і React цього прямо не радить.
  if (submitted !== syncedWith) {
    setSyncedWith(submitted)
    setQuery(submitted)
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    const result = validate(catalogSearchRequestSchema, { q: query })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    router.push(`/catalog?q=${encodeURIComponent(result.data.q)}`)
  }

  /**
   * Вибір зовнішньої картки веде ДАЛІ з цим самим записом, а не назад у пошук.
   *
   * Майстер підхоплює його й одразу починає перевірку дублікатів, тож людина не
   * шукає й не обирає книжку вдруге. Записів у БД це не створює: їх створюють
   * лише кроки майстра після підтвердження.
   *
   * Адреса несе ТОКЕН цього переходу, а не просто позначку: у сховищі лежить
   * один запис, а адрес може бути скільки завгодно, тож «щось збережено й в
   * адресі написано external» ще не означає, що це одне й те саме. Без збігу
   * токена майстер відкриває звичайний пошук.
   *
   * Якщо сховище недоступне (приватний режим, заблоковані дані сайту), передати
   * запис нема як — тоді майстер відкривається зі звичайним пошуком і тим самим
   * запитом. Гірше, але чесно: вдавати, що вибір зберігся, не можна.
   */
  function continueWithExternal(result: ExternalSearchResult): void {
    const token = stashExternalSelection(result, submitted)
    const target = `/catalog/new?q=${encodeURIComponent(submitted)}`

    router.push(token === undefined ? target : `${target}&external=${encodeURIComponent(token)}`)
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

  const localResults = search.status === 'ready' ? search.response.results : []
  const rows = buildUnifiedResults(
    submitted,
    localResults,
    external.status === 'ready' ? external.results : [],
  )

  // «Нічого не знайдено» можна казати лише тоді, коли відповіли ОБИДВА пошуки.
  // Поки одне з джерел ще опитують, порожній список означає «ще ні», а не
  // «немає».
  const finished = search.status === 'ready' && externalSearchSettled(external)

  return (
    <Shell>
      <p className="lede">
        Спершу пошукайте книжку тут: якщо її вже завели, вам лишиться додати собі примірник.
      </p>

      <form className="search" onSubmit={submit} noValidate>
        <TextField
          id="catalog-query"
          label="Назва, автор або ISBN"
          name="q"
          autoComplete="off"
          hint="Мінімум два символи. Шукаємо у BookSwap і в зовнішніх каталогах."
          value={query}
          error={errors.q ?? errors.form}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <button type="submit">Знайти</button>
      </form>

      {search.status === 'loading' && <p className="status status--pending">Шукаю…</p>}
      {search.status === 'error' && <FormStatus error={new Error(search.message)} />}

      {search.status === 'idle' && (
        <p className="empty">Уведіть щонайменше два символи — і побачите, що вже є в базі.</p>
      )}

      {rows.length > 0 && (
        <ul className="books">
          {rows.map((row) =>
            row.origin === 'LOCAL' ? (
              <LocalResultCard
                key={row.key}
                candidate={row.candidate}
                href={`/works/${row.candidate.work.id}`}
                note={MATCH_LABELS[row.candidate.matchedOn]}
              />
            ) : (
              <ExternalResultCard
                key={row.key}
                result={row.result}
                onSelect={() => {
                  continueWithExternal(row.result)
                }}
              />
            ),
          )}
        </ul>
      )}

      <ExternalSearchStatus state={external} />

      {finished && rows.length === 0 && (
        <p className="empty">
          {externalSearchBlind(external)
            ? 'У BookSwap нічого схожого немає, а зовнішні каталоги не відповіли — чи є там ця книжка, невідомо.'
            : 'Нічого схожого не знайшлося. Схоже, цього твору в базі ще немає — заведіть його.'}
        </p>
      )}

      {/* Ручне додавання доступне і тоді, коли ЛОКАЛЬНИЙ пошук упав. Збій
          нашого пошуку нічого не каже про книжку — він лише означає, що ми не
          подивилися; замикати через нього єдиний шлях завести книжку вручну
          означає карати людину за нашу ж аварію. Сама помилка лишається на
          екрані вище, а «нічого схожого» при цьому не пишеться взагалі. */}
      {(search.status === 'ready' || search.status === 'error') && (
        <p className="form__aside">
          Не знайшли своє?{' '}
          <Link href={`/catalog/new?q=${encodeURIComponent(submitted)}`}>Додати книжку вручну</Link>
        </p>
      )}

      <p className="form__aside">
        <Link href="/library">Моя бібліотека</Link> · <Link href="/friends">Друзі</Link> ·{' '}
        <Link href="/">На головну</Link>
      </p>
    </Shell>
  )
}
