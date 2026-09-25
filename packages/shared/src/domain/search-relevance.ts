/**
 * Title/author relevance for book search results.
 *
 * Lives in `packages/shared` because two callers must agree on it exactly:
 *
 * - the API uses it as a GATE on external providers. Google Books and Open
 *   Library both match the full text of a book, so a query naming a novel
 *   returns every textbook that merely mentions it. Field-restricted queries
 *   narrow that down but do not close it (`intitle:` is a ranking hint, not a
 *   filter), so precision is enforced here, on metadata we actually received.
 * - the web wizard uses it to ORDER one list holding both our own catalog and
 *   external candidates. A single list needs a single comparable score;
 *   computing it twice, differently, is how the two halves would drift.
 *
 * It deliberately answers only "does the title or the author say this": a match
 * in a description, a subject heading or the book's text is not a match.
 */

/**
 * Apostrophe variants, folded before the general rule below.
 *
 * They need their own pass because one of them is not punctuation at all:
 * `ʼ` (U+02BC MODIFIER LETTER APOSTROPHE) is a LETTER to Unicode, so
 * `\p{L}` keeps it and "Пʼятірка" would stay one token while "П'ятірка"
 * became two. Ukrainian text carries all of these interchangeably, and a
 * search must not care which one a catalog happened to store.
 */
const APOSTROPHES = /[\u0027\u0060\u00b4\u02bc\u02b9\u2018\u2019\u201b\u2032]/gu

/**
 * Normalization for comparison — NOT the catalog's `bookswap_norm`.
 *
 * The two are different on purpose and must not be confused. `bookswap_norm`
 * lives in Postgres because `Work.titleNorm` has to match a normalized query
 * character for character (see `apps/api/src/catalog/search-text.ts`); it costs
 * a round trip. This one is a pure in-process fold used to compare strings we
 * already hold in memory — external titles that are in no table at all.
 *
 * Case, stray whitespace and punctuation all disappear, and that is what makes
 * apostrophe variants equal: `'`, `’` and `ʼ` are punctuation, so "Мавка" in
 * «Лісова пісня» spelled with either apostrophe folds to the same words.
 */
export function comparableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(APOSTROPHES, ' ')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The same fold, split into words. An empty string yields no tokens, not `['']`. */
export function comparableTokens(value: string): string[] {
  const normalized = comparableText(value)

  return normalized === '' ? [] : normalized.split(' ')
}

/**
 * Endings a word may be carrying, written as they look AFTER `comparableText`.
 *
 * That last part is not a detail: the fold runs NFKD and drops combining
 * marks, so `й` has already become `и` and `ї` has become `і` by the time a
 * word reaches here. The adjective ending `-ий` is therefore spelled `ии`
 * below, and `-ій` is `іи`. Writing them in their unfolded form would simply
 * never match anything.
 *
 * The list is closed, short, and deliberately holds only NOMINAL and
 * ADJECTIVAL endings. Verb endings are left out on purpose — `-ло` is what
 * makes "чорнило" look like an inflected "чорний", and no book search is
 * improved by conjugating.
 *
 * `''` is in the list because the nominative carries no ending at all: it is
 * what lets "Кобзаря" and "Кобзар" meet on the stem "кобзар".
 *
 * English gets `s` and `es` and nothing more. `-y`/`-ies` is omitted although
 * it would pair "history" with "histories": it would also pair "part" with
 * "party", and one missed spelling costs less than one wrong book.
 */
const INFLECTION_ENDINGS = [
  '',
  // Single-vowel and soft-sign endings.
  'а',
  'я',
  'у',
  'ю',
  'и',
  'і',
  'е',
  'о',
  'ь',
  // Two-character nominal and adjectival endings (folded).
  'ии',
  'іи',
  'ои',
  'еи',
  'ою',
  'ею',
  'ам',
  'ах',
  'ям',
  'ях',
  'ом',
  'ем',
  'им',
  'ім',
  'ів',
  'ов',
  'ев',
  'оі',
  'еі',
  // Three-character endings.
  'ого',
  'ому',
  'его',
  'ему',
  'ами',
  'ями',
  'ові',
  'еві',
  'ими',
  'іми',
  // English plurals.
  's',
  'es',
] as const

/**
 * Shortest stem that may stand for a word.
 *
 * Four characters. Below that, too many unrelated words share a stem by
 * chance ("сад"/"сади" is fine, "сад"/"садист" is not), so short words simply
 * have to match exactly — which for short words is no hardship.
 */
const MIN_STEM_LENGTH = 4

/** Every stem this word could have, i.e. the word minus each ending it carries. */
function stemCandidates(word: string): Set<string> {
  const stems = new Set<string>()

  for (const ending of INFLECTION_ENDINGS) {
    if (!word.endsWith(ending)) continue

    const stem = word.slice(0, word.length - ending.length)

    if (stem.length >= MIN_STEM_LENGTH) stems.add(stem)
  }

  return stems
}

/**
 * Are these two words the same word in different grammatical forms?
 *
 * Deliberately NOT "do they share a long prefix". A shared prefix on its own
 * says nothing, because every word is the beginning of unrelated longer ones:
 * that rule made "роман" stand in for "романтика", "слово" for "словник",
 * "чорний" for "чорнило", "wind" for "window". Length thresholds only move
 * where the collisions happen — "чорни" is five characters of agreement
 * between two different words.
 *
 * So the question asked is a different one: strip an ending each word actually
 * carries, and do they land on the SAME stem? "багрянии" − "ии" and
 * "багряного" − "ого" both give "багрян". "чорнии" − "ии" gives "чорн", while
 * "чорнило" carries no ending from the list at all and stays itself — they
 * never meet, which is the correct answer.
 *
 * A Ukrainian morphological dictionary is what would answer this properly and
 * this project has none. The approximation errs towards NO: a false yes puts
 * a book the person did not ask for in front of them, a false no costs one
 * spelling of one query while the exact form still works.
 */
function sameStem(token: string, word: string): boolean {
  const candidates = stemCandidates(token)

  for (const stem of stemCandidates(word)) {
    if (candidates.has(stem)) return true
  }

  return false
}

/** Exact word → 1, same stem → 0.6, otherwise 0. Exactness is what ranks above partial. */
function tokenMatch(token: string, word: string): number {
  if (token === word) return 1

  return sameStem(token, word) ? 0.6 : 0
}

/** The metadata a candidate is judged on — title and authors, and nothing else. */
export interface RelevanceSubject {
  title: string
  authors?: readonly string[] | undefined
}

export interface Relevance {
  /**
   * Every token of the query was found in the title or among the authors.
   *
   * This is the gate. `false` means the provider matched something we cannot
   * see — the description, the subject list, the book's own text — and such a
   * record is not a search result.
   */
  matched: boolean
  /** Higher is more relevant. Comparable across our catalog and external sources. */
  score: number
}

const EXACT_TITLE_BONUS = 1000
const WHOLE_QUERY_IN_TITLE_BONUS = 400
const TITLE_COVERAGE_WEIGHT = 200
const AUTHOR_COVERAGE_WEIGHT = 100
const TITLE_TIGHTNESS_WEIGHT = 100

/**
 * Scores one candidate against the query.
 *
 * The ordering the weights encode, strongest first:
 *
 * 1. **The title IS the query.** «Тигролови» beats «Тигролови та інші повісті»,
 *    which is the explicit "exact title above partial" rule.
 * 2. **Every word of the query is in the title**, each as a whole word. A
 *    stem-only match scores below an exact one by construction, because its
 *    weight is 0.6 and this bonus needs a full 1 per token.
 * 3. **How much of the query the title carries**, then how much the authors
 *    carry. A query split across the two ("Тигролови Багряний") therefore
 *    ranks below a pure title hit but well above an unrelated book.
 * 4. **How much of the title the query covers** — the tie-breaker that keeps a
 *    short, exactly-matching title ahead of a long one that contains it.
 *
 * Author matches are weighted below title matches rather than equally: the
 * wizard's field asks for a title first, and an author's whole bibliography is
 * a weaker answer to "which book is this" than the book itself.
 */
export function relevanceOf(query: string, subject: RelevanceSubject): Relevance {
  const tokens = comparableTokens(query)

  if (tokens.length === 0) return { matched: false, score: 0 }

  const titleWords = comparableTokens(subject.title)
  const authorWords = (subject.authors ?? []).flatMap((author) => comparableTokens(author))

  let titleWeight = 0
  let authorWeight = 0
  let matchedTokens = 0
  // Indices, not words: two identical words in a title are two words, and
  // counting one of them twice would overstate how much of the title is covered.
  const coveredTitleWords = new Set<number>()

  for (const token of tokens) {
    let bestTitle = 0
    let bestTitleIndex = -1

    titleWords.forEach((word, index) => {
      const weight = tokenMatch(token, word)

      if (weight > bestTitle) {
        bestTitle = weight
        bestTitleIndex = index
      }
    })

    let bestAuthor = 0

    for (const word of authorWords) bestAuthor = Math.max(bestAuthor, tokenMatch(token, word))

    if (bestTitle > 0) {
      titleWeight += bestTitle
      coveredTitleWords.add(bestTitleIndex)
    }

    authorWeight += bestAuthor

    if (bestTitle > 0 || bestAuthor > 0) matchedTokens += 1
  }

  const exactTitle = comparableText(subject.title) === comparableText(query)
  // `>= tokens.length` can only be reached when every token scored a full 1.
  const wholeQueryInTitle = titleWeight >= tokens.length
  const titleTightness = titleWords.length === 0 ? 0 : coveredTitleWords.size / titleWords.length

  const score =
    (exactTitle ? EXACT_TITLE_BONUS : 0) +
    (wholeQueryInTitle ? WHOLE_QUERY_IN_TITLE_BONUS : 0) +
    Math.round((TITLE_COVERAGE_WEIGHT * titleWeight) / tokens.length) +
    Math.round((AUTHOR_COVERAGE_WEIGHT * authorWeight) / tokens.length) +
    Math.round(TITLE_TIGHTNESS_WEIGHT * titleTightness)

  return { matched: matchedTokens === tokens.length, score }
}
