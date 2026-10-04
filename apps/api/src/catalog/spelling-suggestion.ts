import type { SpellingCandidate } from './catalog.search'

/**
 * Підказка виправлення написання («Гарі Потер» → «Гаррі Поттер»): чиста логіка рішення, без БД.
 *
 * Оцінка `pg_trgm.similarity` — не відсоток імовірності, а впорядкування. Пороги підібрані на
 * контрольних прикладах (`spelling-suggestion.spec.ts`; значення з реального `pg_trgm` на `bookswap_norm`):
 * «Гарі Потер» → «Гаррі Поттер» 0.60, «Кобзарь» → «Кобзар» 0.67, «Шентарам» → «Шантарам» 0.50, але
 * «Стівен Кінг» → «Стефан Кінг» 0.41 — інша людина, і підказки там бути не повинно.
 */

/** Нижче цього «схоже» ще не означає «це та сама назва з помилкою». */
export const SPELLING_MIN_SCORE = 0.5

/** Наскільки найкращий кандидат мусить випереджати другого, щоб вибір не був жеребкуванням. */
export const SPELLING_MIN_MARGIN = 0.1

/** Для коротших запитів триграм замало: будь-яка літера міняє оцінку більше, ніж сама помилка. */
export const SPELLING_MIN_QUERY_CHARS = 4

const tokensOf = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '')

/**
 * Запит, кожне слово якого — початок якогось слова назви, — це не помилка, а недописаний чи
 * скорочений запит («гаррі поттер філософський» → «гаррі поттер і філософський камінь»): людині
 * показують результати, а не «виправляють» її.
 */
function isTokenPrefixOf(term: string, candidate: string): boolean {
  const words = tokensOf(candidate)

  return tokensOf(term).every((token) => words.some((word) => word.startsWith(token)))
}

/**
 * Кандидати з різних видань і джерел, що пишуться однаково, — ОДИН кандидат: їх впізнають за словами
 * нормалізованого тексту, тож регістр, розділові знаки й пробіли різниці не роблять. Лишається найвища
 * оцінка, а за рівних — перший (локальні кандидати йдуть першими: це наша, а не чужа форма запису).
 * Без цього три видання «Гаррі Поттер» виглядали б як три суперечливі варіанти.
 */
function distinct(candidates: readonly SpellingCandidate[]): SpellingCandidate[] {
  const bySignature = new Map<string, SpellingCandidate>()

  for (const candidate of candidates) {
    const signature = tokensOf(candidate.textNorm).join(' ')
    const known = bySignature.get(signature)

    if (known === undefined || candidate.score > known.score) bySignature.set(signature, candidate)
  }

  return [...bySignature.values()].sort((one, other) => other.score - one.score)
}

/**
 * @param term нормалізований запит (`bookswap_norm`)
 * @param partialMatch у нашому каталозі є звичайний частковий збіг (підрядок) — виправляти нічого
 * @param candidates усі кандидати разом — з нашої БД і з відповідей зовнішніх джерел, у будь-якому
 *   порядку. Це НЕ лише претенденти: кандидат із точним чи частковим збігом (підрядок, початки слів)
 *   теж «голосує» — якщо джерело пише запит так само, як людина, виправляти її нема за чим.
 * @returns текст підказки або `undefined`
 */
export function chooseSpellingSuggestion(
  term: string,
  partialMatch: boolean,
  candidates: readonly SpellingCandidate[],
): string | undefined {
  if (partialMatch || Array.from(term).length < SPELLING_MIN_QUERY_CHARS) return undefined

  // Збіг із записом, який джерело знає: підрядок або кожне слово запиту — початок слова назви.
  if (
    candidates.some(
      (candidate) => candidate.textNorm.includes(term) || isTokenPrefixOf(term, candidate.textNorm),
    )
  ) {
    return undefined
  }

  const [best, runnerUp] = distinct(candidates)

  if (best === undefined || best.score < SPELLING_MIN_SCORE) return undefined
  if (runnerUp !== undefined && best.score - runnerUp.score < SPELLING_MIN_MARGIN) return undefined

  return best.text
}
