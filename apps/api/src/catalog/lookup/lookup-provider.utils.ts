import { CATALOG_LIMITS, type EditionFormat } from '@bookswap/shared'

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const strings = value.map(nonEmptyString).filter((entry): entry is string => entry !== undefined)

  return strings.length === 0 ? undefined : strings
}

export function extractPublishedYear(value: unknown): number | undefined {
  const text = nonEmptyString(value)
  if (text === undefined) return undefined

  const match = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(text)
  return match === null ? undefined : Number(match[0])
}

export function exactIsbn13(candidate: unknown, expected: string): boolean {
  const value = nonEmptyString(candidate)
  return value !== undefined && value.replace(/[\s-]/g, '') === expected
}

export function positivePageCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= CATALOG_LIMITS.pageCountMax
    ? value
    : undefined
}

export function normalizedCoverUrl(value: unknown): string | undefined {
  const url = nonEmptyString(value)
  if (url === undefined) return undefined
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
  return url.startsWith('https://') ? url : undefined
}

/** Google Books descriptions may contain a small HTML subset; catalog text must not. */
export function plainTextDescription(value: unknown): string | undefined {
  const html = nonEmptyString(value)
  if (html === undefined) return undefined

  const text = html
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

  if (text === '') return undefined
  return text.slice(0, CATALOG_LIMITS.descriptionMax)
}

export function editionFormatFromBinding(value: unknown): EditionFormat | undefined {
  const binding = nonEmptyString(value)?.toLocaleLowerCase()
  if (binding === undefined) return undefined

  if (/hardcover|hardback|casebound|cloth|тверд/iu.test(binding)) return 'HARDCOVER'
  if (/mass market|pocket|кишень/iu.test(binding)) return 'POCKET'
  if (/paperback|softcover|м.?як/iu.test(binding)) return 'PAPERBACK'

  return undefined
}
