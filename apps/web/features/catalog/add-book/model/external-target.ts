import {
  OPEN_LIBRARY_WORK_ID_PATTERN,
  type ExternalSearchResult,
  type QuickAddTarget,
} from '@bookswap/shared'

/** `<SOURCE>:<externalId>` of a result's `id` (or of the form's `record`): the record the person chose. */
export function recordKeyOf(recordId: string): { source: string; externalId: string } | undefined {
  const separator = recordId.indexOf(':')

  return separator < 1
    ? undefined
    : { source: recordId.slice(0, separator), externalId: recordId.slice(separator + 1) }
}

/**
 * Що саме просити в сервера, коли користувач додає зовнішній запис (docs/plan/fast-book-add.md, §5.3).
 *
 * Клієнт називає лише ІДЕНТИЧНІСТЬ — пару `(source, externalId)` і/або ISBN. Метадані сервер бере в
 * джерела сам; жодних назв, авторів чи URL із браузера він не приймає.
 *
 * Запис про твір (`WORK`, BS-114) — це `EXTERNAL_WORK`: сервер створює твір і видання «без уточнення», де
 * видавничі дані невідомі, тож запис не видається за конкретне видання.
 *
 * `undefined` — додати нічого: запис без жодного ідентифікатора, придатного для точного звернення.
 */
export function externalTarget(result: ExternalSearchResult): QuickAddTarget | undefined {
  const { source, externalId } = recordKeyOf(result.id) ?? { source: undefined, externalId: '' }

  if (result.kind === 'WORK') {
    return source === 'OPEN_LIBRARY' && OPEN_LIBRARY_WORK_ID_PATTERN.test(externalId)
      ? { kind: 'EXTERNAL_WORK', source: 'OPEN_LIBRARY', externalId }
      : undefined
  }

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
  const { source, externalId } = recordKeyOf(result.id) ?? { source: undefined, externalId: '' }

  return [
    ...(source === 'GOOGLE_BOOKS' && externalId !== '' ? [`gb:${externalId}`] : []),
    // A work record's ISBN would be some printing's: it must not share that printing's slot.
    ...(result.isbn13 === undefined || result.kind === 'WORK' ? [] : [`isbn:${result.isbn13}`]),
    `external:${result.id}`,
  ]
}
