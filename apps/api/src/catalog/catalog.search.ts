import type { RawQueryRunner } from './search-text'
import { Prisma } from '../generated/prisma/client'

/**
 * Сирий SQL пошуку. Живе окремо від сервісу, щоб запит читався як запит.
 *
 * Це перший `$queryRaw` у продакшн-коді репозиторію, і причина одна: fuzzy-пошук
 * (§6.3, крок 2) Prisma не виражає — ні `similarity()`, ні оператора `%`, ні
 * триграмних індексів у її API немає. Далі результат відразу повертається в
 * типізований світ: запит віддає **тільки id і оцінки**, а самі записи підтягує
 * `findMany`. Так сирим лишається рівно ранжування, а не проєкція даних.
 */

/** §6.3: «similarity(titleNorm, $1) > 0.3». */
export const SIMILARITY_THRESHOLD = 0.3

export interface RankedWork {
  id: string
  titleScore: number
  authorScore: number
}

export interface RankedAuthor {
  id: string
  score: number
}

/**
 * Поріг фіксується на транзакцію, а не береться з конфігурації сервера.
 *
 * Оператор `%` — єдиний спосіб задіяти GIN-індекс (`similarity() > 0.3` його не
 * використовує), але поріг він читає з `pg_trgm.similarity_threshold`. Дефолт
 * там і так 0.3, проте покладатися на налаштування чужого сервера означало б
 * мати різну поведінку пошуку локально й у проді. `set_config(..., true)` діє до
 * кінця транзакції й нічого не лишає по собі.
 */
export async function pinSimilarityThreshold(client: RawQueryRunner): Promise<void> {
  await client.$queryRaw`
    SELECT set_config('pg_trgm.similarity_threshold', ${String(SIMILARITY_THRESHOLD)}, true)
  `
}

/**
 * §8: «fuzzy-пошук по Work + Author». Твір потрапляє у видачу, якщо схожа його
 * назва **або** імʼя когось із авторів; оцінка — краще з двох.
 *
 * Умови з `LIKE` — це префікс і підрядок. Триграмна схожість на коротких запитах
 * провалюється арифметично: «шан» проти «шантарам» дає рівно 0.3, тобто нижче
 * порога, а «ґре» проти «ґреґорі девід робертс» — узагалі 0.13. Пошук на третій
 * літері замовкав би саме тоді, коли людина тільки почала друкувати. `LIKE '%…%'`
 * теж лягає на триграмний GIN-індекс, тож ці гілки не роблять запит послідовним
 * скануванням.
 *
 * `LIKE` стоїть на **обох** колонках, і це не симетрія заради симетрії. Без нього
 * на `nameNorm` короткий фрагмент імені знаходив автора в `rankAuthors` (там обидві
 * гілки були від початку), але не знаходив жодного його твору тут — видача, у якій
 * автор є, а його книжок немає, виглядає як поламаний пошук.
 *
 * `mergedIntoId IS NULL` прибирає з видачі те, що вже злите в канонічний запис
 * (§6.3). Сам мердж — наступний етап; умова коштує рядок і не дає забути про неї
 * тоді, коли дублікати вже зʼявляться.
 *
 * **Порядок тотальний — `w.id` останнім ключем.** Це не косметика, а вимога
 * пагінації: `ORDER BY score DESC, titleNorm ASC` двох творів з однаковою оцінкою
 * й однаковою нормалізованою назвою не розрізняє, і Postgres має право віддати їх
 * у різному порядку в різних запитах. На одній сторінці це непомітно, на
 * сторінках — рівно та поломка, коли між сусідніми сторінками один твір зникає, а
 * інший показується двічі. Див. `docs/plan/stage-9-search-pagination.md`.
 */
export function rankWorks(
  client: RawQueryRunner,
  term: string,
  pattern: string,
  limit: number,
  allowedWorkIds?: readonly string[],
): Promise<RankedWork[]> {
  if (allowedWorkIds?.length === 0) return Promise.resolve([])

  const allowed =
    allowedWorkIds === undefined
      ? Prisma.empty
      : Prisma.sql`AND w.id IN (${Prisma.join([...allowedWorkIds])})`

  return client.$queryRaw<RankedWork[]>`
    SELECT w.id AS id,
           similarity(w."titleNorm", ${term}::text) AS "titleScore",
           COALESCE(MAX(similarity(a."nameNorm", ${term}::text)), 0) AS "authorScore"
    FROM "Work" w
    LEFT JOIN "WorkAuthor" wa ON wa."workId" = w.id
    LEFT JOIN "Author" a ON a.id = wa."authorId"
    WHERE w."mergedIntoId" IS NULL
      ${allowed}
      AND (
        w."titleNorm" % ${term}::text
        OR a."nameNorm" % ${term}::text
        OR w."titleNorm" LIKE ${pattern}::text
        OR a."nameNorm" LIKE ${pattern}::text
      )
    GROUP BY w.id
    ORDER BY GREATEST(
               similarity(w."titleNorm", ${term}::text),
               COALESCE(MAX(similarity(a."nameNorm", ${term}::text)), 0)
             ) DESC,
             w."titleNorm" ASC,
             w.id ASC
    LIMIT ${limit}
  `
}

/**
 * Ті самі автори окремим списком — для кроку майстра «виберіть наявного автора
 * або створіть нового». Автоматично переюзати автора за збігом імені не можна:
 * тезки бувають, і звести двох людей в одну гірше, ніж завести дублікат.
 */
export function rankAuthors(
  client: RawQueryRunner,
  term: string,
  pattern: string,
  limit: number,
): Promise<RankedAuthor[]> {
  return client.$queryRaw<RankedAuthor[]>`
    SELECT a.id AS id, similarity(a."nameNorm", ${term}::text) AS score
    FROM "Author" a
    WHERE a."nameNorm" % ${term}::text OR a."nameNorm" LIKE ${pattern}::text
    ORDER BY score DESC, a."name" ASC, a.id ASC
    LIMIT ${limit}
  `
}

export interface SpellingCandidate {
  /** Як записано в каталозі: саме це й показується людині. */
  text: string
  textNorm: string
  score: number
}

/**
 * Чи є в каталозі звичайний частковий збіг (підрядок назви чи імені автора) — той самий, що вже
 * шукає `rankWorks`. Автор рахується, лише якщо в нього є незлитий твір: інакше пошук нічого б не
 * показав, а виправляти було б нічого.
 */
export async function hasPartialMatch(client: RawQueryRunner, pattern: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ found: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1 FROM "Work" w
        WHERE w."mergedIntoId" IS NULL AND w."titleNorm" LIKE ${pattern}::text
      )
      OR EXISTS (
        SELECT 1 FROM "Author" a
        WHERE a."nameNorm" LIKE ${pattern}::text
          AND EXISTS (
            SELECT 1 FROM "WorkAuthor" wa
            JOIN "Work" w ON w.id = wa."workId"
            WHERE wa."authorId" = a.id AND w."mergedIntoId" IS NULL
          )
      )
    ) AS found
  `

  return rows[0]?.found === true
}

/**
 * Два найсхожіших РІЗНИХ тексти серед назв творів і імен авторів. Дві сутності з однаковим
 * нормалізованим текстом — один кандидат, а не двоє: «неоднозначність» означає різні написання, а не
 * дублікат у каталозі. Оцінка — лише порядок, не імовірність; поріг і запас обирає
 * `chooseSpellingSuggestion`.
 */
export function rankSpellingCandidates(
  client: RawQueryRunner,
  term: string,
): Promise<SpellingCandidate[]> {
  return client.$queryRaw<SpellingCandidate[]>`
    SELECT c.text AS text, c."textNorm" AS "textNorm", c.score AS score
    FROM (
      SELECT DISTINCT ON (u."textNorm") u.text, u."textNorm", u.score
      FROM (
        SELECT w.title AS text, w."titleNorm" AS "textNorm",
               similarity(w."titleNorm", ${term}::text) AS score
        FROM "Work" w
        WHERE w."mergedIntoId" IS NULL AND w."titleNorm" % ${term}::text
        UNION ALL
        SELECT a.name AS text, a."nameNorm" AS "textNorm",
               similarity(a."nameNorm", ${term}::text) AS score
        FROM "Author" a
        WHERE a."nameNorm" % ${term}::text
          AND EXISTS (
            SELECT 1 FROM "WorkAuthor" wa
            JOIN "Work" w ON w.id = wa."workId"
            WHERE wa."authorId" = a.id AND w."mergedIntoId" IS NULL
          )
      ) u
      ORDER BY u."textNorm", u.score DESC, u.text ASC
    ) c
    ORDER BY c.score DESC, c."textNorm" ASC
    LIMIT 2
  `
}

/**
 * Той самий вимір схожості для текстів, яких у нашій БД немає (назви й автори з відповідей зовнішніх
 * джерел): `bookswap_norm` і `similarity` рахує сама БД, тож оцінка й поріг ті самі, що в
 * `rankSpellingCandidates`. Це читання без запису: жодних зовнішніх запитів і жодних нових рядків.
 */
export function scoreSpellingTexts(
  client: RawQueryRunner,
  term: string,
  texts: readonly string[],
): Promise<SpellingCandidate[]> {
  if (texts.length === 0) return Promise.resolve([])

  return client.$queryRaw<SpellingCandidate[]>`
    SELECT t.text AS text,
           bookswap_norm(t.text) AS "textNorm",
           similarity(bookswap_norm(t.text), ${term}::text) AS score
    FROM unnest(${[...texts]}::text[]) AS t(text)
  `
}
