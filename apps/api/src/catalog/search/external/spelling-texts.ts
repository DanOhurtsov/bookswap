import type { ExternalSearchResult } from '@bookswap/shared'

/**
 * Distinct titles and author names of the records a provider has just parsed — the raw material of
 * `ExternalSearchBlockResult.spellingCandidates`. Exact-string de-duplication only: deciding which
 * spellings are "the same" needs the database's normalization and belongs to `chooseSpellingSuggestion`.
 */
export function spellingTexts(records: readonly ExternalSearchResult[]): string[] {
  const texts = new Set<string>()

  for (const record of records) {
    texts.add(record.title)

    for (const author of record.authors ?? []) texts.add(author)
  }

  return [...texts]
}
