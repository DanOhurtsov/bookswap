import { z } from 'zod'
import { editionFormatSchema } from '../domain/catalog'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'

/**
 * §6.3, крок 1 і §11: автозаповнення форми додавання книги за ISBN.
 *
 * Джерело правди лишається власна база (§6.3) — зовнішній провайдер лише
 * пропонує чернетку полів, тому вся форма нижче опційна, крім `title`: без
 * назви показувати автозаповнення нема сенсу, решту користувач і так
 * редагує руками перед збереженням.
 */

export const bookLookupRequestSchema = z.object({
  isbn: isbn13Schema,
})

export type BookLookupRequest = z.infer<typeof bookLookupRequestSchema>

export const BOOK_LOOKUP_SOURCES = ['OPEN_LIBRARY', 'GOOGLE_BOOKS', 'ISBNDB'] as const

export const bookLookupSourceSchema = z.enum(BOOK_LOOKUP_SOURCES)

export type BookLookupSource = z.infer<typeof bookLookupSourceSchema>

/**
 * Нормалізована форма, спільна для всіх провайдерів (Open Library і будь-який
 * майбутній).
 *
 * Кожне поле описує конкретне ISBN-видання (`Edition`), не абстрактний твір
 * (§4.4, §6.3): провайдер бачить одну книжку в руках, а не її твір загалом.
 * Клієнт (`apps/web/app/lib/lookup-mapping.ts`) відповідає за те, щоб кожне
 * поле потрапило в правильну сутність ланцюга `Work → Translation → Edition`:
 *
 * - `title`, `authors` — єдині поля, що автозаповнюють `Work` (назва й автори
 *   твору не залежать від конкретного видання);
 * - `publishedYear` — рік публікації **цього видання** (`publish_date` у
 *   Open Library), тобто `Edition.year`. Він НЕ є роком першої публікації
 *   твору (`Work.firstPubYear`) — перевидання новіші за оригінал, а провайдер
 *   не повідомляє окреме work-level поле, тож `Work.firstPubYear`
 *   автозаповненню з lookup не підлягає взагалі;
 * - `publisher`, `coverUrl` — теж належать виданню (`Edition.publisher`,
 *   `Edition.coverUrl`);
 * - `language` — мова тексту цього видання. У домені немає окремого поля
 *   `Edition.lang` (воно обчислюється з `Translation.lang` або
 *   `Work.origLang`), тож це поле може автозаповнити лише `Translation.lang`
 *   (мову, на яку перекладено) — ніколи `Work.origLang` (мову оригіналу
 *   провайдер не повідомляє) і ніколи `Translation.sourceLang` (з якої мови
 *   перекладено — вгадувати заборонено).
 *
 * `externalId` — суто довідковий (§6.3: «зовнішній ID не зберігається як
 * залежність»): клієнт не зобов'язаний його передавати назад при створенні
 * `Work`/`Edition`, і бекенд ніде на нього не посилається через FK.
 */
export const bookLookupResultSchema = z.object({
  title: z.string().min(1),
  authors: z.array(z.string().min(1)).optional(),
  /** Рік публікації саме цього видання — `Edition.year`, не `Work.firstPubYear`. */
  publishedYear: z.number().int().optional(),
  /** ISO 639-1, уже нормалізований провайдером (§6.3 п.7). Цільове поле — лише `Translation.lang`. */
  language: languageCodeSchema.optional(),
  publisher: z.string().optional(),
  description: z.string().min(1).optional(),
  pageCount: z.number().int().positive().max(20_000).optional(),
  format: editionFormatSchema.optional(),
  coverUrl: z.string().optional(),
  /** Provider that supplied the exact ISBN record. Optional for legacy cache rows. */
  source: bookLookupSourceSchema.optional(),
  externalId: z.string().optional(),
  /** Strong Open Library Work match, kept as reference metadata rather than a catalog FK. */
  workExternalId: z.string().optional(),
})

export type BookLookupResult = z.infer<typeof bookLookupResultSchema>

export const bookLookupResponseSchema = z.object({
  result: bookLookupResultSchema,
})

export type BookLookupResponse = z.infer<typeof bookLookupResponseSchema>
