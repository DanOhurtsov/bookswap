import { Injectable } from '@nestjs/common'
import { isLanguageCode, type BookLookupResult } from '@bookswap/shared'
import { BookLookupProviderError, type BookLookupProvider } from './book-lookup-provider'
import { lookupUserAgentHeaders } from './lookup.config'
import {
  editionFormatFromBinding,
  exactIsbn13,
  nonEmptyString,
  positivePageCount,
  stringArray,
} from './lookup-provider.utils'

const API_ROOT = 'https://openlibrary.org/api/books.json'
const SEARCH_API_ROOT = 'https://openlibrary.org/search.json'

interface OpenLibraryAuthor {
  name?: string
}

interface OpenLibraryPublisher {
  name?: string
}

interface OpenLibraryCover {
  small?: string
  medium?: string
  large?: string
}

interface OpenLibraryLanguage {
  key?: string
}

interface OpenLibraryBookRecord {
  key?: string
  title?: string
  authors?: OpenLibraryAuthor[]
  publish_date?: string
  publishers?: OpenLibraryPublisher[]
  cover?: OpenLibraryCover
  languages?: OpenLibraryLanguage[]
  number_of_pages?: number
  physical_format?: string
}

/**
 * Open Library кодує мову виданнями MARC (= ISO 639-2, здебільшого форма /B):
 * `/languages/eng`, `/languages/ukr`. Домен репозиторію (§4.4, `languageCodeSchema`)
 * прийняв ISO 639-1 — двобуквені коди, — тому мапа нижче переводить трибуквені
 * MARC-коди на дволітерні. Обидві форми (bibliographic/terminologic), де вони
 * розходяться, ведуть до того самого ISO 639-1, напр. `ger`/`deu` → `de`.
 *
 * Список — таблиця ISO 639-2 ↔ ISO 639-1, а не здогад: мова, якої тут немає
 * (напр. `mul` — «кілька мов», `und` — «не визначено»), лишається
 * ненормалізованою — див. §6.3 п.7: «невідоме значення залишай порожнім, а не
 * підміняй випадковим default».
 */
const ISO_639_2_TO_1: Readonly<Record<string, string>> = {
  aar: 'aa',
  abk: 'ab',
  ave: 'ae',
  afr: 'af',
  aka: 'ak',
  amh: 'am',
  arg: 'an',
  ara: 'ar',
  asm: 'as',
  ava: 'av',
  aym: 'ay',
  aze: 'az',
  bak: 'ba',
  bel: 'be',
  bul: 'bg',
  bih: 'bh',
  bis: 'bi',
  bam: 'bm',
  ben: 'bn',
  tib: 'bo',
  bod: 'bo',
  bre: 'br',
  bos: 'bs',
  cat: 'ca',
  che: 'ce',
  cha: 'ch',
  cos: 'co',
  cre: 'cr',
  cze: 'cs',
  ces: 'cs',
  chu: 'cu',
  chv: 'cv',
  wel: 'cy',
  cym: 'cy',
  dan: 'da',
  ger: 'de',
  deu: 'de',
  div: 'dv',
  dzo: 'dz',
  ewe: 'ee',
  gre: 'el',
  ell: 'el',
  eng: 'en',
  epo: 'eo',
  spa: 'es',
  est: 'et',
  baq: 'eu',
  eus: 'eu',
  per: 'fa',
  fas: 'fa',
  ful: 'ff',
  fin: 'fi',
  fij: 'fj',
  fao: 'fo',
  fre: 'fr',
  fra: 'fr',
  fry: 'fy',
  gle: 'ga',
  gla: 'gd',
  glg: 'gl',
  grn: 'gn',
  guj: 'gu',
  glv: 'gv',
  hau: 'ha',
  heb: 'he',
  hin: 'hi',
  hmo: 'ho',
  hrv: 'hr',
  hat: 'ht',
  hun: 'hu',
  arm: 'hy',
  hye: 'hy',
  her: 'hz',
  ina: 'ia',
  ind: 'id',
  ile: 'ie',
  ibo: 'ig',
  iii: 'ii',
  ipk: 'ik',
  ido: 'io',
  ice: 'is',
  isl: 'is',
  ita: 'it',
  iku: 'iu',
  jpn: 'ja',
  jav: 'jv',
  geo: 'ka',
  kat: 'ka',
  kon: 'kg',
  kik: 'ki',
  kua: 'kj',
  kaz: 'kk',
  kal: 'kl',
  khm: 'km',
  kan: 'kn',
  kor: 'ko',
  kau: 'kr',
  kas: 'ks',
  kur: 'ku',
  kom: 'kv',
  cor: 'kw',
  kir: 'ky',
  lat: 'la',
  ltz: 'lb',
  lug: 'lg',
  lim: 'li',
  lin: 'ln',
  lao: 'lo',
  lit: 'lt',
  lub: 'lu',
  lav: 'lv',
  mlg: 'mg',
  mah: 'mh',
  mao: 'mi',
  mri: 'mi',
  mac: 'mk',
  mkd: 'mk',
  mal: 'ml',
  mon: 'mn',
  mar: 'mr',
  may: 'ms',
  msa: 'ms',
  mlt: 'mt',
  bur: 'my',
  mya: 'my',
  nau: 'na',
  nob: 'nb',
  nde: 'nd',
  nep: 'ne',
  ndo: 'ng',
  dut: 'nl',
  nld: 'nl',
  nno: 'nn',
  nor: 'no',
  nbl: 'nr',
  nav: 'nv',
  nya: 'ny',
  oci: 'oc',
  oji: 'oj',
  orm: 'om',
  ori: 'or',
  oss: 'os',
  pan: 'pa',
  pli: 'pi',
  pol: 'pl',
  pus: 'ps',
  por: 'pt',
  que: 'qu',
  roh: 'rm',
  run: 'rn',
  rum: 'ro',
  ron: 'ro',
  rus: 'ru',
  kin: 'rw',
  san: 'sa',
  srd: 'sc',
  snd: 'sd',
  sme: 'se',
  sag: 'sg',
  sin: 'si',
  slo: 'sk',
  slk: 'sk',
  slv: 'sl',
  smo: 'sm',
  sna: 'sn',
  som: 'so',
  alb: 'sq',
  sqi: 'sq',
  srp: 'sr',
  ssw: 'ss',
  sot: 'st',
  sun: 'su',
  swe: 'sv',
  swa: 'sw',
  tam: 'ta',
  tel: 'te',
  tgk: 'tg',
  tha: 'th',
  tir: 'ti',
  tuk: 'tk',
  tgl: 'tl',
  tsn: 'tn',
  ton: 'to',
  tur: 'tr',
  tso: 'ts',
  tat: 'tt',
  twi: 'tw',
  tah: 'ty',
  uig: 'ug',
  ukr: 'uk',
  urd: 'ur',
  uzb: 'uz',
  ven: 've',
  vie: 'vi',
  vol: 'vo',
  wln: 'wa',
  wol: 'wo',
  xho: 'xh',
  yid: 'yi',
  yor: 'yo',
  zha: 'za',
  chi: 'zh',
  zho: 'zh',
  zul: 'zu',
}

/**
 * `/languages/eng` → `eng` → `en`. Невідомий, відсутній чи неочікуваного типу
 * (Open Library — зовнішній сервіс, тіло не типізоване рантаймом) код →
 * `undefined`, а не кинутий виняток: одне зіпсоване поле не має валити весь
 * lookup, коли решта відповіді придатна.
 */
export function normalizeOpenLibraryLanguage(languages: unknown): string | undefined {
  if (!Array.isArray(languages)) return undefined

  const first = languages[0] as OpenLibraryLanguage | undefined
  const key = first?.key
  if (typeof key !== 'string') return undefined

  const marc = key.split('/').pop()?.trim().toLowerCase()
  if (marc === undefined || marc === '') return undefined

  const code = ISO_639_2_TO_1[marc]

  return code !== undefined && isLanguageCode(code) ? code : undefined
}

/** Open Library повертає всі bibkeys одним об'єктом, ключ — `ISBN:<isbn>`. */
type OpenLibraryBooksResponse = Record<string, OpenLibraryBookRecord | undefined>

/**
 * Stage 8f-2: what one batch answered. `found` and `failed` are disjoint, and an
 * ISBN in neither was simply not in the answer — the provider's way of saying it
 * has no record.
 */
export interface OpenLibraryBatchResult {
  found: Map<string, BookLookupResult>
  /** ISBNs whose record came back unreadable, with the reason. */
  failed: Map<string, string>
}

interface OpenLibrarySearchDocument {
  key?: unknown
  title?: unknown
  author_name?: unknown
  isbn?: unknown
}

function comparableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function workIdFromKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/works\/OL[0-9]+W$/u.test(value)) return undefined
  return value.slice('/works/'.length)
}

function resultFromIsbnSearchDocument(value: unknown, isbn: string): BookLookupResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const document = value as OpenLibrarySearchDocument
  if (!Array.isArray(document.isbn) || !document.isbn.some((entry) => exactIsbn13(entry, isbn))) {
    return undefined
  }

  const title = nonEmptyString(document.title)
  if (title === undefined) return undefined

  const authors = stringArray(document.author_name)
  const workExternalId = workIdFromKey(document.key)

  return {
    title,
    ...(authors === undefined ? {} : { authors }),
    ...(workExternalId === undefined ? {} : { workExternalId }),
  }
}

async function lookupByIsbnSearch(
  isbn: string,
  signal: AbortSignal,
): Promise<BookLookupResult | undefined> {
  const url = new URL(SEARCH_API_ROOT)
  url.searchParams.set('isbn', isbn)
  url.searchParams.set('fields', 'key,title,author_name,isbn')
  url.searchParams.set('limit', '5')

  let response: Response

  try {
    response = await fetch(url, { signal })
  } catch (error) {
    throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
  }

  if (!response.ok) {
    throw new BookLookupProviderError(
      `Open Library ISBN search відповів HTTP ${String(response.status)}`,
    )
  }

  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BookLookupProviderError('Open Library ISBN search повернув не JSON-об’єкт')
  }

  const documents = (body as Record<string, unknown>).docs
  if (!Array.isArray(documents)) return undefined

  for (const document of documents) {
    const result = resultFromIsbnSearchDocument(document, isbn)
    if (result !== undefined) return result
  }

  return undefined
}

/** Перший рік у рядку виду «March 2003», «2003», «Jul 08, 2003». */
function extractYear(publishDate: unknown): number | undefined {
  if (typeof publishDate !== 'string') return undefined

  const match = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(publishDate)

  return match === null ? undefined : Number(match[0])
}

/** `/books/OL123456M` → `OL123456M`. */
function externalIdFromKey(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined

  return key.split('/').pop()
}

/** Перше ім'я в масиві, що справді є непорожнім рядком — байдуже, що там ще намішано. */
function firstName(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined

  const name = (entries[0] as { name?: unknown } | undefined)?.name

  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/** Перша обкладинка, що справді є рядком-URL, у порядку «більша краще». */
function coverUrlFrom(cover: unknown): string | undefined {
  if (typeof cover !== 'object' || cover === null) return undefined

  const { large, medium, small } = cover as Record<string, unknown>

  for (const candidate of [large, medium, small]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }

  return undefined
}

/**
 * Stage 8f-2, R7: Open Library's usage guidelines cap a Books API call in
 * practice, and ask for batching rather than hundreds of single-book requests.
 */
export const OPEN_LIBRARY_BIBKEYS_PER_REQUEST = 50

/** One Books API call for any number of bibkeys, with the identified `User-Agent` R7 requires. */
async function fetchBooks(
  bibkeys: readonly string[],
  signal: AbortSignal,
): Promise<OpenLibraryBooksResponse> {
  // Assembled by hand rather than through `URLSearchParams`: bibkeys are
  // `ISBN:<digits>`, and encoding that colon would change the single-ISBN URL
  // this provider has always sent, for no gain.
  const url = `${API_ROOT}?bibkeys=${bibkeys.join(',')}&format=json&jscmd=data`

  let response: Response

  try {
    response = await fetch(url, { signal, headers: lookupUserAgentHeaders() })
  } catch (error) {
    throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
  }

  if (!response.ok) {
    throw new BookLookupProviderError(`Open Library відповів HTTP ${String(response.status)}`)
  }

  const body: unknown = await response.json().catch(() => undefined)

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BookLookupProviderError('Open Library повернув тіло, що не є JSON-об’єктом')
  }

  return body as OpenLibraryBooksResponse
}

/** One `jscmd=data` record → the normalized shared result. */
function resultFromBooksRecord(record: Record<string, unknown>): BookLookupResult {
  const title = record.title

  if (typeof title !== 'string' || title.trim() === '') {
    throw new BookLookupProviderError('Open Library повернув запис без назви')
  }

  const authors = Array.isArray(record.authors)
    ? record.authors
        .map((author: unknown) => (author as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : []

  const publisher = firstName(record.publishers)
  const coverUrl = coverUrlFrom(record.cover)
  const publishedYear = extractYear(record.publish_date)
  const externalId = externalIdFromKey(record.key)
  const language = normalizeOpenLibraryLanguage(record.languages)
  const pageCount = positivePageCount(record.number_of_pages)
  const format = editionFormatFromBinding(record.physical_format)

  return {
    title,
    ...(authors.length > 0 ? { authors } : {}),
    ...(publishedYear === undefined ? {} : { publishedYear }),
    ...(language === undefined ? {} : { language }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(format === undefined ? {} : { format }),
    ...(coverUrl === undefined ? {} : { coverUrl }),
    ...(externalId === undefined ? {} : { externalId }),
  }
}

/**
 * R1: Open Library — без ключа й без квоти.
 *
 * Books API (`jscmd=data`), а не `/isbn/{isbn}.json`: останній віддає авторів
 * лише посиланнями (`/authors/OL...A`) і вимагав би окремого запиту на кожного
 * — N+1 замість одного виклику. Books API одразу вкладає імена авторів,
 * видавця й обкладинку в саму відповідь.
 *
 * Невідомий ISBN — це НЕ HTTP 404: провайдер відповідає 200 з порожнім
 * об'єктом, якщо для запитаного bibkey немає запису. Це і є єдина ознака
 * «не знайдено» для цього API.
 */
@Injectable()
export class OpenLibraryLookupProvider implements BookLookupProvider {
  async lookup(isbn: string, signal: AbortSignal): Promise<BookLookupResult | undefined> {
    const bibkey = `ISBN:${isbn}`
    const body = await fetchBooks([bibkey], signal)
    const record = body[bibkey] as Record<string, unknown> | undefined

    // Books API and Search API use different Open Library indexes. A recently
    // imported edition can temporarily be absent from one but present in the
    // other, so an empty bibkey gets one exact-ISBN search before we move on to
    // another provider.
    if (record === undefined) return lookupByIsbnSearch(isbn, signal)

    return resultFromBooksRecord(record)
  }

  /**
   * Stage 8f-2, R7: one Books API call for up to
   * {@link OPEN_LIBRARY_BIBKEYS_PER_REQUEST} ISBNs — the batching the provider's
   * own guidelines ask for instead of hundreds of single-book requests.
   *
   * Deliberately NOT the batch twin of `lookup()`: no per-ISBN search fallback
   * and no Work enrichment, because either would turn one request back into N.
   *
   * Three outcomes per ISBN, and the third one is the point. A bibkey the answer
   * does not mention is simply absent — Open Library says "no record" that way.
   * A bibkey it DOES mention but whose record we cannot read (no title, a shape
   * we do not understand) is a failure about that one ISBN: reporting it as
   * absent would let a later "nobody found it" become "no such book", which is
   * a different and wrong claim. The other records of the batch are unaffected.
   */
  async lookupMany(isbns: readonly string[], signal: AbortSignal): Promise<OpenLibraryBatchResult> {
    const result: OpenLibraryBatchResult = { found: new Map(), failed: new Map() }

    if (isbns.length === 0) return result
    if (isbns.length > OPEN_LIBRARY_BIBKEYS_PER_REQUEST) {
      throw new BookLookupProviderError(
        `Open Library batch обмежений ${String(OPEN_LIBRARY_BIBKEYS_PER_REQUEST)} bibkeys`,
      )
    }

    const body = await fetchBooks(
      isbns.map((isbn) => `ISBN:${isbn}`),
      signal,
    )

    for (const isbn of isbns) {
      const record = body[`ISBN:${isbn}`] as Record<string, unknown> | undefined

      if (record === undefined) continue

      try {
        result.found.set(isbn, resultFromBooksRecord(record))
      } catch (error) {
        if (!(error instanceof BookLookupProviderError)) throw error

        result.failed.set(isbn, error.message)
      }
    }

    return result
  }

  /**
   * Resolves only a strong title + author match. A title-only result is a suggestion,
   * not enough evidence to attach an edition to an Open Library Work automatically.
   */
  async lookupWork(
    title: string,
    authors: readonly string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (authors.length === 0) return undefined

    const url = new URL(SEARCH_API_ROOT)
    url.searchParams.set('title', title)
    url.searchParams.set('author', authors[0] ?? '')
    url.searchParams.set('fields', 'key,title,author_name')
    url.searchParams.set('limit', '5')

    let response: Response

    try {
      response = await fetch(url, { signal })
    } catch (error) {
      throw new BookLookupProviderError(error instanceof Error ? error.message : 'мережева помилка')
    }

    if (!response.ok) {
      throw new BookLookupProviderError(
        `Open Library work search відповів HTTP ${String(response.status)}`,
      )
    }

    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BookLookupProviderError('Open Library work search повернув не JSON-об’єкт')
    }

    const documents = (body as Record<string, unknown>).docs
    if (!Array.isArray(documents)) return undefined

    const expectedTitle = comparableText(title)
    const expectedAuthors = new Set(authors.map(comparableText))

    for (const value of documents) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue

      const document = value as OpenLibrarySearchDocument
      if (typeof document.title !== 'string' || comparableText(document.title) !== expectedTitle) {
        continue
      }

      if (!Array.isArray(document.author_name)) continue
      const hasExactAuthor = document.author_name.some(
        (author) => typeof author === 'string' && expectedAuthors.has(comparableText(author)),
      )
      if (!hasExactAuthor) continue

      const workId = workIdFromKey(document.key)
      if (workId !== undefined) return workId
    }

    return undefined
  }
}
