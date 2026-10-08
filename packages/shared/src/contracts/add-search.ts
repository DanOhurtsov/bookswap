import { z } from 'zod'
import {
  externalSearchMoreSchema,
  externalSearchResultSchema,
  externalSearchSourceReportSchema,
  spellingSuggestionSchema,
} from './external-search'
import {
  SEARCH_PAGE_SIZES,
  catalogMatchKindSchema,
  catalogSearchRequestSchema,
  editionSchema,
  workAuthorSchema,
  workSchema,
} from './catalog'

/**
 * Пошук для сторінки додавання книжки (docs/plan/fast-book-add.md, §6): `GET /me/library/add-search`.
 *
 * Відмінність від `/catalog/search`: одиниця списку — КОНКРЕТНЕ ВИДАННЯ, а не твір. Одна картка —
 * одна ціль додавання, тож «Додати до бібліотеки» завжди відповідає на питання «яке саме видання».
 * Твір, у якого ще немає жодного видання, лишається окремим елементом `WORK` — його не можна
 * видати за видання; для нього передбачено уточнення.
 *
 * Розгортання з творів у видання робить СЕРВЕР до нарізання сторінки: `total` рахується в
 * елементах, і жодне видання не губиться й не повторюється між сторінками. Зовнішня половина
 * списку (`/me/library/add-search/external`) ділить сторінку за тим самим `total`.
 */

/**
 * Скільки примірників цього видання вже є в ПОТОЧНОГО користувача. Лише власні числа: чужих
 * примірників, їхніх власників і видимості тут немає й бути не може.
 */
export const addSearchOwnershipSchema = z.object({
  /** Активні (не архівні) примірники. `> 0` — «✓ У моїй бібліотеці». */
  activeCount: z.number().int().nonnegative(),
  /** Архівні примірники: показуються окремо, з переходом до наявного відновлення. */
  archivedCount: z.number().int().nonnegative(),
})

export type AddSearchOwnership = z.infer<typeof addSearchOwnershipSchema>

export const addSearchEditionItemSchema = z.object({
  kind: z.literal('EDITION'),
  /** Стабільна ідентичність картки в межах відповіді: `edition:<id>`. */
  key: z.string(),
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  matchedOn: catalogMatchKindSchema,
  ownership: addSearchOwnershipSchema,
})

export type AddSearchEditionItem = z.infer<typeof addSearchEditionItemSchema>

/** Твір без жодного видання в нашому каталозі: абстрактний результат, не конкретна книжка. */
export const addSearchWorkItemSchema = z.object({
  kind: z.literal('WORK'),
  key: z.string(),
  work: workSchema,
  authors: z.array(workAuthorSchema),
  matchedOn: catalogMatchKindSchema,
})

export type AddSearchWorkItem = z.infer<typeof addSearchWorkItemSchema>

export const addSearchItemSchema = z.discriminatedUnion('kind', [
  addSearchEditionItemSchema,
  addSearchWorkItemSchema,
])

export type AddSearchItem = z.infer<typeof addSearchItemSchema>

/**
 * Автопошук під час введення (`/me/library/add-search/suggest[/external]`): режим підказок ФІКСОВАНИЙ —
 * без `page`/`pageSize`, тож клієнт не може його послабити. Ці числа однакові для сервера (валідація,
 * розмір відповіді) і для сторінки (пороги запуску).
 */
export const AUTO_SEARCH_RESULT_LIMIT = 8
/** Від скількох символів шукаємо в нашому каталозі. */
export const AUTO_SEARCH_LOCAL_MIN_CHARS = 2
/** Від скількох символів питаємо зовнішнє джерело (дорожче й обмеженіше за локальний пошук). */
export const AUTO_SEARCH_EXTERNAL_MIN_CHARS = 3

/** Той самий вхід, що й у `/catalog/search`: одне поле, одна сторінка, один розмір. */
export const addSearchRequestSchema = catalogSearchRequestSchema

export type AddSearchRequest = z.infer<typeof addSearchRequestSchema>

export const addSearchResponseSchema = z.object({
  items: z.array(addSearchItemSchema).max(Math.max(...SEARCH_PAGE_SIZES)),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** ТОЧНА кількість елементів-видань (і творів без видань) серед локальних збігів. */
  total: z.number().int().nonnegative(),
  /** Чи лишилися ЛОКАЛЬНІ елементи після цієї сторінки. */
  hasMore: z.boolean(),
  /** Лише коли є впевнений однозначний кандидат і немає точного чи часткового збігу; інакше поля немає. */
  spellingSuggestion: spellingSuggestionSchema.optional(),
})

export type AddSearchResponse = z.infer<typeof addSearchResponseSchema>

/**
 * Зовнішня половина того самого списку: запис зовнішнього джерела (`EXTERNAL`) або НАШЕ видання, яке
 * вже відоме за ISBN чи підтвердженим зовнішнім посиланням, хоча локальний пошук не знайшов його за цим
 * запитом. Заміна робиться на сервері ДО нарізання сторінки, тож видання не зникає з результатів, а
 * кілька представлень одного видання не множать карток.
 */
export const addSearchExternalItemSchema = z.discriminatedUnion('kind', [
  addSearchEditionItemSchema,
  z.object({
    kind: z.literal('EXTERNAL'),
    /** Стабільна ідентичність картки: `external:<SOURCE>:<id>`. */
    key: z.string(),
    result: externalSearchResultSchema,
  }),
])

export type AddSearchExternalItem = z.infer<typeof addSearchExternalItemSchema>

export const addSearchExternalResponseSchema = z.object({
  items: z.array(addSearchExternalItemSchema).max(Math.max(...SEARCH_PAGE_SIZES)),
  sources: z.array(externalSearchSourceReportSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  more: externalSearchMoreSchema,
  complete: z.boolean(),
  /** Рішення за ЛОКАЛЬНИМИ і зовнішніми кандидатами разом; див. `spellingSuggestionSchema`. */
  spellingSuggestion: spellingSuggestionSchema.optional(),
})

export type AddSearchExternalResponse = z.infer<typeof addSearchExternalResponseSchema>
