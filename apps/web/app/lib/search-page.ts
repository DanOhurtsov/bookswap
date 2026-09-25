import {
  DEFAULT_SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE,
  searchPageSchema,
  searchPageSizeSchema,
  type SearchPageSize,
} from '@bookswap/shared'

/**
 * Pagination address helpers shared by `/catalog` discovery and the add-book
 * wizard's local/external result list.
 *
 * Живе в `app/lib`, а не у фічі додавання книжки, бо ним користуються хуки, обидві
 * сторінки й компонент керування. Рішення, які ці функції втілюють, —
 * `docs/plan/stage-9-search-pagination.md`.
 */

/** Що адреса каже про поточний пошук: запит, сторінка, розмір. */
export interface SearchAddress {
  q: string
  page: number
  pageSize: SearchPageSize
}

/**
 * Номер сторінки з адреси.
 *
 * Адреса без `page` — це перша сторінка, а не помилка. Усе інше проходить ту
 * саму перевірку, що й на сервері (`searchPageSchema`), тож клієнт не надсилає
 * запиту, який гарантовано отримає 400, і не показує сторінки, якої не буває.
 *
 * `undefined` означає «в адресі написано щось, що сторінкою не є» — і це не те
 * саме, що відсутній параметр: показати можна лише першу, але адресу при цьому
 * треба виправити, інакше вміст і адреса розійдуться.
 */
export function pageFromParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return 1

  const parsed = searchPageSchema.safeParse(raw)

  return parsed.success ? parsed.data : undefined
}

/** Розмір сторінки з адреси; відсутній — типовий, недопустимий — `undefined`. */
export function pageSizeFromParam(raw: string | null): SearchPageSize | undefined {
  if (raw === null || raw === '') return DEFAULT_SEARCH_PAGE_SIZE

  const parsed = searchPageSizeSchema.safeParse(raw)

  return parsed.success ? parsed.data : undefined
}

/**
 * Прочитаний пошук з адреси.
 *
 * `valid: false`, коли `page` чи `pageSize` написано нісенітницю: показується
 * перша сторінка типового розміру, а сторінка виправляє адресу (`replace`, не
 * `push`), щоб «назад» не вертало на помилкову.
 */
export function readSearchAddress(parameters: URLSearchParams): SearchAddress & { valid: boolean } {
  const page = pageFromParam(parameters.get('page'))
  const pageSize = pageSizeFromParam(parameters.get('pageSize'))

  return {
    q: parameters.get('q') ?? '',
    page: page ?? 1,
    pageSize: pageSize ?? DEFAULT_SEARCH_PAGE_SIZE,
    valid: page !== undefined && pageSize !== undefined,
  }
}

/**
 * Адреса пошуку.
 *
 * Канонічна адреса мінімальна: перша сторінка не несе `page=1`, типовий розмір —
 * `pageSize=10`; дві адреси для однієї сторінки зробили б «назад» несподіваним.
 *
 * Усі ІНШІ параметри поточної адреси (`mode`, `workId`, `external` майстра…)
 * переносяться як є, крім названих у `drop`: зміна сторінки не має губити те, що
 * потрібно сканеру чи переходу з вибраним записом.
 */
export function searchHref(
  pathname: string,
  current: URLSearchParams,
  next: SearchAddress,
  drop: readonly string[] = [],
): string {
  const parameters = new URLSearchParams()

  parameters.set('q', next.q)
  if (next.page > 1) parameters.set('page', String(next.page))
  if (next.pageSize !== DEFAULT_SEARCH_PAGE_SIZE) parameters.set('pageSize', String(next.pageSize))

  for (const [key, value] of current) {
    if (key === 'q' || key === 'page' || key === 'pageSize' || drop.includes(key)) continue

    parameters.append(key, value)
  }

  return `${pathname}?${parameters.toString()}`
}

/**
 * Ключ відповіді: запит, сторінка й розмір разом.
 *
 * `\u0000` не може трапитися в набраному запиті, тож жодна трійка не збігається з
 * іншою — «тигролови» на сторінці 12 і «тигролови 1» на сторінці 2 лишаються
 * різними питаннями.
 */
export function askedFor(query: string, page: number, pageSize: number): string {
  return `${String(page)}\u0000${String(pageSize)}\u0000${query}`
}

/** Чи чесно обіцяти наступну сторінку. */
export type NextPage = 'PROVEN' | 'POSSIBLE' | 'NONE'

/**
 * Що сказати про наступну сторінку.
 *
 * Найдалі — `SEARCH_MAX_PAGE`: сторінки 21 сервер не знає, тож посилання на неї
 * не малюється НІКОЛИ, навіть коли записи глибше існують. `PROVEN` — є доказ
 * (локальний `hasMore` або зовнішній `more = YES`); `POSSIBLE` — доказу немає, але
 * зовнішні потоки не вичерпані (`more = UNKNOWN`): кнопка «Далі» є, номера сторінки
 * — ні.
 */
export function nextPageOf(input: {
  page: number
  localHasMore: boolean
  externalMore: 'YES' | 'NO' | 'UNKNOWN'
}): NextPage {
  if (input.page >= SEARCH_MAX_PAGE) return 'NONE'
  if (input.localHasMore || input.externalMore === 'YES') return 'PROVEN'

  return input.externalMore === 'UNKNOWN' ? 'POSSIBLE' : 'NONE'
}

export type PageLink = number | 'gap'

/**
 * Номери сторінок для показу — лише тих, існування яких ВІДОМЕ.
 *
 * Перша існує завжди. Попередні існують, коли ПОТОЧНА має рядки (сторінка N з
 * рядками означає, що N−1 були повні). Наступна — лише за доказом. Загальної
 * кількості сторінок немає ніде, тож і «останньої» не вигадуємо.
 */
export function knownPageLinks(input: {
  page: number
  currentHasRows: boolean
  next: NextPage
}): PageLink[] {
  const { page } = input
  const links: PageLink[] = [1]
  const previous = input.currentHasRows ? page - 1 : 0

  if (previous > 1) {
    if (previous > 2) links.push('gap')
    links.push(previous)
  }

  if (page > 1) links.push(page)
  if (input.next === 'PROVEN') links.push(page + 1)

  return links
}
