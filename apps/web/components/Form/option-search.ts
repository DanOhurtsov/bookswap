/** Every apostrophe a keyboard may type, as the one the Ukrainian names are written with (U+02BC). */
const APOSTROPHES = /['’`ʼ]/g

function normalizeSearchText(text: string): string {
  return text.trim().toLocaleLowerCase('uk').replace(APOSTROPHES, 'ʼ')
}

/**
 * Whether an option's visible name matches what was typed into a combobox's search: a substring
 * match ignoring case, surrounding spaces and the apostrophe variant («в'єт» finds «вʼєтнамська»).
 * An empty search matches everything.
 */
export function matchesSearch(label: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query)

  return normalizedQuery === '' || normalizeSearchText(label).includes(normalizedQuery)
}
