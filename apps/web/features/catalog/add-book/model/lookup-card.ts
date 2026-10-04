import type { AddSearchExternalItem, AddSearchItem } from '@bookswap/shared'

/**
 * Чи показувати окрему картку точного ISBN-пошуку (`LookupAddCard`).
 *
 * Сторінка — ОДИН список результатів: те саме видання не може з'явитися двічі, хоч би з яких половин
 * (місцева, зовнішня, точний lookup) воно прийшло. Картка lookup зайва, коли видання з цим ISBN уже є серед
 * наших результатів АБО серед зовнішніх (запис із таким ISBN чи наше видання, підставлене сервером).
 */
export function lookupCardIsRedundant(
  isbn: string,
  local: readonly AddSearchItem[],
  external: readonly AddSearchExternalItem[],
): boolean {
  return (
    local.some((item) => item.kind === 'EDITION' && item.edition.isbn13 === isbn) ||
    external.some((item) =>
      item.kind === 'EDITION' ? item.edition.isbn13 === isbn : item.result.isbn13 === isbn,
    )
  )
}
