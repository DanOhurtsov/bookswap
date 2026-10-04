import type { ExternalSearchResult, QuickAddTarget } from '@bookswap/shared'

/**
 * Що саме просити в сервера, коли користувач додає зовнішній запис (docs/plan/fast-book-add.md, §5.3).
 *
 * Клієнт називає лише ІДЕНТИЧНІСТЬ — пару `(source, externalId)` і/або ISBN. Метадані сервер бере в
 * джерела сам; жодних назв, авторів чи URL із браузера він не приймає.
 *
 * `undefined` — додати нічого: запис про твір (`WORK`) чи видання без жодного ідентифікатора, придатного
 * для точного звернення. Такий запис не видається за конкретне видання.
 */
export function externalTarget(result: ExternalSearchResult): QuickAddTarget | undefined {
  if (result.kind !== 'EDITION') return undefined

  const separator = result.id.indexOf(':')
  const source = separator < 1 ? undefined : result.id.slice(0, separator)
  const externalId = separator < 1 ? '' : result.id.slice(separator + 1)

  if (source === 'GOOGLE_BOOKS' && externalId !== '') {
    return {
      kind: 'EXTERNAL_EDITION',
      source: 'GOOGLE_BOOKS',
      externalId,
      ...(result.isbn13 === undefined ? {} : { isbn13: result.isbn13 }),
    }
  }

  return result.isbn13 === undefined
    ? undefined
    : { kind: 'EXTERNAL_EDITION', isbn13: result.isbn13 }
}

/**
 * Усі відомі ідентичності цього видання: вони ділять один слот додавання зі своїм локальним представленням
 * (`edition:<id>`, `isbn:<isbn>`), тож дві картки одного видання не запускають двох операцій.
 */
export function externalIdentities(result: ExternalSearchResult): string[] {
  const separator = result.id.indexOf(':')
  const source = separator < 1 ? undefined : result.id.slice(0, separator)
  const externalId = separator < 1 ? '' : result.id.slice(separator + 1)

  return [
    ...(source === 'GOOGLE_BOOKS' && externalId !== '' ? [`gb:${externalId}`] : []),
    ...(result.isbn13 === undefined ? [] : [`isbn:${result.isbn13}`]),
    `external:${result.id}`,
  ]
}
