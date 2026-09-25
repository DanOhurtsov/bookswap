import { z } from 'zod'
import { authorRoleSchema, editionFormatSchema } from '../domain/catalog'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'

/**
 * §6.3 і §8, блок «Каталог».
 *
 * Чотири сутності ланцюга §3 лишаються чотирма й у контракті: `Work` не має полів
 * видання, `Edition` не має полів примірника. Спокуса злити їх в один «Book» — це
 * рівно та помилка, від якої застерігає §3.
 *
 * `Copy` тут немає взагалі: каталог — спільні метадані, а хто чим володіє, живе в
 * `contracts/library.ts` і проходить крізь матрицю §9.
 */

export const CATALOG_SEARCH_LIMIT = 20

/**
 * Допустимі розміри сторінки спільного списку — КІЛЬКІСТЬ КАРТОК у списку
 * загалом, а не «стільки-то локальних плюс стільки-то зовнішніх».
 *
 * Розкладає сторінку по джерелах {@link splitSearchPage}; рішення й наслідки —
 * `docs/plan/stage-9-search-pagination.md`.
 */
export const SEARCH_PAGE_SIZES = [10, 20, 50] as const

export type SearchPageSize = (typeof SEARCH_PAGE_SIZES)[number]

export const DEFAULT_SEARCH_PAGE_SIZE: SearchPageSize = 10

/**
 * Найбільший номер сторінки, який приймає пошук (1-based).
 *
 * Без верхньої межі `page=100000` перетворюється на `OFFSET 1000000` у нашій базі
 * й на таку саму глибину `startIndex` у чужій. Двадцять сторінок — це 400 рядків
 * на запит «як називається моя книжка»; глибше гортають не люди.
 */
export const SEARCH_MAX_PAGE = 20

/**
 * Скільки збігів локального пошуку матеріалізується під один запит.
 *
 * `rankWorks` віддає не сторінку, а весь список збігів до цієї межі. Один
 * індексований запит дає три речі одразу: сторінку, ТОЧНУ ознаку «є ще» і повний
 * набір ISBN для дедуплікації проти зовнішніх джерел
 * ({@link catalogSearchResponseSchema.knownIsbn13}). Обрізання свідоме: глибше
 * {@link SEARCH_MAX_PAGE} ні «є ще», ні повнота набору ISBN не гарантуються.
 */
export const CATALOG_SEARCH_MAX_MATCHES = 200

/**
 * Номер сторінки з рядка запиту.
 *
 * `coerce`, бо в `?page=2` завжди приїжджає рядок; `default(1)` — бо адреса без
 * `page` означає першу сторінку, а не помилку. Нецілий, нульовий чи завеликий
 * номер — це 400: мовчки підставити першу сторінку означало б показати НЕ ТЕ, що
 * просить адреса, і «назад» повело б людину не туди.
 */
export const searchPageSchema = z.coerce
  .number()
  .int('Номер сторінки має бути цілим')
  .min(1, 'Сторінки нумеруються з одиниці')
  .max(SEARCH_MAX_PAGE)

/**
 * Розмір сторінки з рядка запиту. Значення поза {@link SEARCH_PAGE_SIZES} — 400,
 * а не найближче допустиме: адреса має означати те, що написано.
 */
export const searchPageSizeSchema = z.coerce
  .number()
  .int('Розмір сторінки має бути цілим')
  .refine(
    (value): value is SearchPageSize => (SEARCH_PAGE_SIZES as readonly number[]).includes(value),
    {
      message: `Розмір сторінки — один із ${SEARCH_PAGE_SIZES.join(', ')}`,
    },
  )

/**
 * Як сторінка спільного списку ділиться між джерелами.
 *
 * Спільний список — це ЛОКАЛЬНІ збіги (у порядку рангу бази), за якими йде
 * зовнішній пул. Сторінка N розміру S — рядки `[a, b)`, `a = (N−1)·S`,
 * `b = N·S`. Чиста функція номера сторінки, розміру та кількості локальних
 * збігів `L`, тож пряме посилання не потребує історії, а обидва ендпоінти,
 * порахувавши `L` самі, узгоджено відрізають свою частину й стартують
 * паралельно.
 */
export interface SearchPageSplit {
  localFrom: number
  localCount: number
  externalFrom: number
  externalCount: number
}

export function splitSearchPage(input: {
  page: number
  pageSize: number
  localTotal: number
}): SearchPageSplit {
  const from = (input.page - 1) * input.pageSize
  const localFrom = Math.min(from, input.localTotal)
  const localCount = Math.min(Math.max(input.localTotal - from, 0), input.pageSize)

  return {
    localFrom,
    localCount,
    externalFrom: Math.max(from - input.localTotal, 0),
    externalCount: input.pageSize - localCount,
  }
}

/**
 * Обмеження полів каталогу. Ті самі числа потрібні `class-validator`-декораторам
 * у `apps/api` (§11 вимагає обидва механізми), тож живуть константами.
 */
export const CATALOG_LIMITS = {
  titleMax: 300,
  descriptionMax: 2000,
  authorNameMax: 200,
  translatorMax: 200,
  publisherMax: 200,
  notesMax: 1000,
  coverUrlMax: 2048,
  idMax: 64,
  pageCountMax: 20_000,
  authorsMax: 10,
  queryMin: 2,
  queryMax: 200,
  /** Найдавніші твори — до нашої ери; верхня межа лишає запас на анонси. */
  yearMin: -4000,
  yearMax: 2100,
} as const

const yearSchema = z.number().int().min(CATALOG_LIMITS.yearMin).max(CATALOG_LIMITS.yearMax)

const idSchema = z.string().trim().min(1).max(CATALOG_LIMITS.idMax)

// --- Проєкції ----------------------------------------------------------------

/**
 * Твір **без** авторів: вони йдуть окремим полем поруч, а не вкладеними в нього.
 *
 * Так однакову форму мають і пошук, і сторінка твору, і роль автора (`AuthorRole`
 * зі `WorkAuthor`) не доводиться вигадувати, куди подіти — вона властивість
 * звʼязку, а не людини.
 */
export const workSchema = z.object({
  id: z.string(),
  title: z.string(),
  origLang: z.string(),
  firstPubYear: z.number().int().nullable(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Stage 8e-1, R9: optimistic concurrency — see `expectedRevisionSchema`. */
  revision: z.number().int().positive(),
})

export type Work = z.infer<typeof workSchema>

export const workAuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLatin: z.string().nullable(),
  role: authorRoleSchema,
  /**
   * Stage 8e-1, R10a: manual order within the work's author list. `0, 1, 2, …`
   * without gaps or repeats across the whole list — role does not restart it.
   */
  position: z.number().int().nonnegative(),
})

export type WorkAuthor = z.infer<typeof workAuthorSchema>

/**
 * Переклад із фактичними ознаками §10.3 — тими, що заповнюються при додаванні
 * книжки й не залежать від чиєїсь думки.
 *
 * `score`, `ratingAvg`, `ratingCount` навмисно відсутні: без правила cold start
 * (§10.3) клієнт малював би «0.0» під кожним перекладом. Сортування за `score`
 * (§8) робить сервер — для нього поле в контракті не потрібне. Ранг приїде разом
 * зі §10 на етапі оцінок.
 */
export const translationSchema = z.object({
  id: z.string(),
  workId: z.string(),
  translator: z.string(),
  lang: z.string(),
  sourceLang: z.string(),
  year: z.number().int().nullable(),
  isAbridged: z.boolean(),
  hasNotes: z.boolean(),
  notes: z.string().nullable(),
  /** §10.3: «перевидають те, що продається» — непрямий сигнал якості. */
  editionCount: z.number().int().nonnegative(),
  /** Stage 8e-1, R9: optimistic concurrency — see `expectedRevisionSchema`. */
  revision: z.number().int().positive(),
})

export type Translation = z.infer<typeof translationSchema>

/**
 * Видання. `lang` і `translator` — обчислені: для видання мовою оригіналу
 * (`translationId = null`) це `Work.origLang` і `null`.
 *
 * Рахує їх сервер, а не клієнт: інакше кожна сторінка, що показує видання,
 * повторювала б це «якщо переклад є — беремо з нього» і одного дня помилилася б.
 */
export const editionSchema = z.object({
  id: z.string(),
  workId: z.string(),
  translationId: z.string().nullable(),
  publisher: z.string().nullable(),
  year: z.number().int().nullable(),
  isbn13: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  format: editionFormatSchema,
  lang: z.string(),
  translator: z.string().nullable(),
  /** Stage 8e-1, R9: optimistic concurrency — see `expectedRevisionSchema`. */
  revision: z.number().int().positive(),
})

export type Edition = z.infer<typeof editionSchema>

// --- Пошук -------------------------------------------------------------------

/**
 * Сам запит, без сторінки.
 *
 * Окремо від {@link catalogSearchRequestSchema}, бо `page` потрібен НЕ всім, хто
 * приймає `q`: `/catalog/search/candidates` — це підказка «може, така книжка вже
 * є» перед створенням твору, і пагінації в ній немає навмисно (див.
 * {@link SEARCH_CANDIDATES_LIMIT}). Спільний тут рівно один рядок поля вводу —
 * розійтися в межах `q` два ендпоінти не мають права.
 */
export const catalogQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(CATALOG_LIMITS.queryMin, 'Мінімум два символи')
    .max(CATALOG_LIMITS.queryMax),
})

export type CatalogQuery = z.infer<typeof catalogQuerySchema>

export const catalogSearchRequestSchema = catalogQuerySchema.extend({
  page: searchPageSchema.default(1),
  pageSize: searchPageSizeSchema.default(DEFAULT_SEARCH_PAGE_SIZE),
})

export type CatalogSearchRequest = z.infer<typeof catalogSearchRequestSchema>

export const CATALOG_MATCH_KINDS = ['TITLE', 'AUTHOR', 'ISBN'] as const

export const catalogMatchKindSchema = z.enum(CATALOG_MATCH_KINDS)

export type CatalogMatchKind = z.infer<typeof catalogMatchKindSchema>

/**
 * §6.3, крок 2: «Можливо, це одна з цих?» — разом із виданнями.
 *
 * Видання приїжджають одразу, бо саме на них людина впізнає своє: «КСД, 2019» їй
 * каже більше, ніж назва твору. Без них крок 3 («знайшов своє видання →
 * створюється лише Copy») вимагав би ще одного запиту на кожен показаний твір.
 */
export const catalogSearchResultSchema = z.object({
  work: workSchema,
  authors: z.array(workAuthorSchema),
  editions: z.array(editionSchema),
  matchedOn: catalogMatchKindSchema,
})

export type CatalogSearchResult = z.infer<typeof catalogSearchResultSchema>

/**
 * Знайдені автори — окремо від творів.
 *
 * Пошук і так рахує схожість за іменем автора (§8: «fuzzy-пошук по Work +
 * Author»), тож віддати самих авторів нічого не коштує. Живить це крок майстра
 * «виберіть наявного автора або створіть нового»: автоматично переюзати автора за
 * збігом імені не можна — тезки бувають.
 */
export const authorMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLatin: z.string().nullable(),
  workCount: z.number().int().nonnegative(),
})

export type AuthorMatch = z.infer<typeof authorMatchSchema>

export const catalogSearchResponseSchema = z.object({
  results: z.array(catalogSearchResultSchema).max(Math.max(...SEARCH_PAGE_SIZES)),
  /**
   * Знайдені автори НЕ пагінуються: це не список для гортання, а матеріал для
   * кроку «виберіть наявного автора». Тому список той самий на кожній сторінці.
   */
  authorMatches: z.array(authorMatchSchema).max(CATALOG_SEARCH_LIMIT),
  /** Яку саме сторінку описує ця відповідь (1-based) — те, що просили. */
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /**
   * ТОЧНА кількість локальних збігів (не більше {@link CATALOG_SEARCH_MAX_MATCHES}).
   * З неї обидва ендпоінти рахують, скільки рядків сторінки — локальні
   * ({@link splitSearchPage}). На екрані це НЕ «усього знайдено»: зовнішні
   * джерела чесної загальної кількості не мають.
   */
  total: z.number().int().nonnegative(),
  /** Чи лишилися ЛОКАЛЬНІ рядки після цієї сторінки — перелічені, а не оцінка. */
  hasMore: z.boolean(),
})

export type CatalogSearchResponse = z.infer<typeof catalogSearchResponseSchema>

// --- Читання -----------------------------------------------------------------

/**
 * Stage 8e-2, R10/R8: what the current viewer may `PATCH` on this Work,
 * computed server-side so the client never has to guess or duplicate R8's
 * ownership rule. `canEditWork` covers the Work itself; the two id lists name
 * exactly which of the Work's Translations/Editions the viewer may also PATCH
 * — a viewer can hold Edition-level rights (owns a Copy of it) without
 * Work-level ones, and vice versa.
 */
export const viewerCapabilitiesSchema = z.object({
  canEditWork: z.boolean(),
  editableTranslationIds: z.array(z.string()),
  editableEditionIds: z.array(z.string()),
})

export type ViewerCapabilities = z.infer<typeof viewerCapabilitiesSchema>

/**
 * `viewerCapabilities` is optional: only `GET /works/:id` and `POST /works`
 * (Stage 8e-2) compute it for the requesting user. `SearchCandidatesResponse`
 * (Stage 7c) reuses this exact shape for its `candidates` — a before-selection
 * preview where "can I edit this" is not yet a question the UI asks — and
 * omits the field rather than paying for a permission check nobody reads.
 */
export const workDetailResponseSchema = z.object({
  work: workSchema,
  authors: z.array(workAuthorSchema),
  translations: z.array(translationSchema),
  editions: z.array(editionSchema),
  viewerCapabilities: viewerCapabilitiesSchema.optional(),
})

export type WorkDetailResponse = z.infer<typeof workDetailResponseSchema>

/** §8: «впорядковані за score, з ознаками». Порядок задає сервер. */
export const translationListResponseSchema = z.object({
  translations: z.array(translationSchema),
})

export type TranslationListResponse = z.infer<typeof translationListResponseSchema>

export const editionDetailResponseSchema = z.object({
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  translation: translationSchema.nullable(),
})

export type EditionDetailResponse = z.infer<typeof editionDetailResponseSchema>

// --- Canonical resolution after a merge (§6.3; stage 7h) ---------------------

/**
 * The `details` payload that rides along with `WORK_MERGED`.
 *
 * Reads carry it in the body of the 301, writes in the body of the 409, and it
 * is the same shape either way: the client needs the same two facts in both
 * cases — which work it asked for, and which one answers for it now.
 *
 * Resolution is exactly one hop deep, so `canonicalWorkId` is never itself
 * merged. That is invariant R4, held by `merge.service.ts`: a merge whose source
 * or target is already merged is refused, and every incoming `mergedIntoId` is
 * repointed at the new target.
 */
export const workMergedDetailsSchema = z.object({
  canonicalWorkId: z.string(),
  requestedWorkId: z.string(),
})

export type WorkMergedDetails = z.infer<typeof workMergedDetailsSchema>

// --- Кандидати для дедуплікації (§6.3, крок 2; Етап 7c) ----------------------

/**
 * Скільки кандидатів дає перевірка дублікатів без `page`/`pageSize` — топ-N
 * підказка «може, така книжка вже є». Гортає майстер інший запит (з `page`), а
 * перевірка дублікатів завжди питає перший екран і від сторінки не залежить.
 * Ту саму межу використовує імпорт бібліотеки.
 */
export const SEARCH_CANDIDATES_LIMIT = 10

/**
 * Той самий вхід, що й у `/catalog/search`. Без `page`/`pageSize` це рівно
 * перший екран — топ-{@link SEARCH_CANDIDATES_LIMIT}, і саме так його кличе
 * перевірка дублікатів: вона НЕ залежить від сторінки, яку зараз гортає майстер.
 */
export const searchCandidatesRequestSchema = catalogSearchRequestSchema

export type SearchCandidatesRequest = z.infer<typeof searchCandidatesRequestSchema>

/**
 * Кожен кандидат — це `WorkDetailResponse`: та сама форма, що й у `GET
 * /works/:id`, з усіма `Edition` і `Translation` твору. Людина впізнає своє
 * видання за видавництвом і роком так само, як на сторінці твору.
 *
 * Слайс і лічильники — ті самі, що й у {@link catalogSearchResponseSchema}: майстер
 * і `/catalog` гортають один і той самий список.
 */
export const searchCandidatesResponseSchema = z.object({
  candidates: z.array(workDetailResponseSchema).max(Math.max(...SEARCH_PAGE_SIZES)),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type SearchCandidatesResponse = z.infer<typeof searchCandidatesResponseSchema>

// --- Створення ---------------------------------------------------------------

/**
 * A Work's author: **either** an existing author's id, **or** a new one's
 * name. Exactly one of the two.
 *
 * Auto-deduplication ("an author with this name already exists — reuse it")
 * is forbidden here: namesakes happen, and silently merging two different
 * people into one is worse than a duplicate `Author` row (at least a
 * duplicate is visible and can be merged later, §6.3).
 *
 * `nameLatin` only makes sense paired with `name` (a NEW author) — it sets
 * the transliteration of the author being created. When `authorId` selects
 * an EXISTING author instead, `nameLatin` here is NOT a channel to edit that
 * global `Author` row's transliteration: `Author` is shared across every
 * Work that references it, and R10 (docs/plan/stage-8-inventory.md) already
 * forbids a catalog PATCH on one Work from silently renaming it for all the
 * others — the same rule covers `nameLatin`. PO decision (Stage 8e-2, R10a):
 * the write path REJECTS `authorId` + `nameLatin` together — with 400, even
 * when `nameLatin` is explicitly `null` — rather than silently ignoring it;
 * see `strictWorkAuthorInputSchema` (`catalog-correction.ts`) for the PATCH-only
 * refinement that enforces this (create's `workAuthorInputSchema` below is
 * unaffected — this object schema itself stays permissive, same as before).
 *
 * Pre-`refine()` shape below, exported so `catalog-correction.ts` (Stage
 * 8e-1 PATCH) can build a `.strict()` variant off the same fields instead of
 * redeclaring them. `workAuthorInputSchema` further down keeps its exact
 * current shape and unknown-key behavior (strip) — this export changes
 * nothing for create.
 */
export const workAuthorInputObjectSchema = z.object({
  authorId: idSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1, 'Не вказано імʼя автора')
    .max(CATALOG_LIMITS.authorNameMax)
    .optional(),
  nameLatin: z.string().trim().min(1).max(CATALOG_LIMITS.authorNameMax).nullable().optional(),
  role: authorRoleSchema.optional(),
})

export const AUTHOR_HAS_ONE_SOURCE_MESSAGE =
  'Потрібен або authorId наявного автора, або name нового — рівно одне з двох'

export function authorHasOneSource(value: { authorId?: string; name?: string }): boolean {
  return (value.authorId === undefined) !== (value.name === undefined)
}

export const workAuthorInputSchema = workAuthorInputObjectSchema.refine(
  authorHasOneSource,
  AUTHOR_HAS_ONE_SOURCE_MESSAGE,
)

export type WorkAuthorInput = z.infer<typeof workAuthorInputSchema>

export const createWorkRequestSchema = z.object({
  title: z.string().trim().min(1, 'Не вказано назву').max(CATALOG_LIMITS.titleMax),
  origLang: languageCodeSchema,
  firstPubYear: yearSchema.nullable().optional(),
  description: z.string().trim().max(CATALOG_LIMITS.descriptionMax).nullable().optional(),
  // Хоча б один автор: твір без автора не знайдеться пошуком по автору (§8) і
  // не дасть §10 жодного сигналу.
  authors: z
    .array(workAuthorInputSchema)
    .min(1, 'Потрібен хоча б один автор')
    .max(CATALOG_LIMITS.authorsMax),
})

export type CreateWorkRequest = z.infer<typeof createWorkRequestSchema>

export const createTranslationRequestSchema = z.object({
  translator: z.string().trim().min(1, 'Не вказано перекладача').max(CATALOG_LIMITS.translatorMax),
  lang: languageCodeSchema,
  /** §10.3: з якої мови перекладали — найсильніший сигнал при cold start. */
  sourceLang: languageCodeSchema,
  year: yearSchema.nullable().optional(),
  isAbridged: z.boolean().optional(),
  hasNotes: z.boolean().optional(),
  notes: z.string().trim().max(CATALOG_LIMITS.notesMax).nullable().optional(),
})

export type CreateTranslationRequest = z.infer<typeof createTranslationRequestSchema>

export const translationResponseSchema = z.object({
  translation: translationSchema,
})

export type TranslationResponse = z.infer<typeof translationResponseSchema>

/** `translationId: null` — видання мовою оригіналу (§4.4). */
export const createEditionRequestSchema = z.object({
  translationId: idSchema.nullable().optional(),
  publisher: z.string().trim().min(1).max(CATALOG_LIMITS.publisherMax).nullable().optional(),
  year: yearSchema.nullable().optional(),
  isbn13: isbn13Schema.nullable().optional(),
  pageCount: z.number().int().min(1).max(CATALOG_LIMITS.pageCountMax).nullable().optional(),
  coverUrl: z.url('Некоректне посилання').max(CATALOG_LIMITS.coverUrlMax).nullable().optional(),
  format: editionFormatSchema.optional(),
})

export type CreateEditionRequest = z.infer<typeof createEditionRequestSchema>

export const editionResponseSchema = z.object({
  edition: editionSchema,
})

export type EditionResponse = z.infer<typeof editionResponseSchema>
