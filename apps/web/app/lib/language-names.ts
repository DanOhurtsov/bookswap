/**
 * Назва мови українською за кодом ISO 639-1 («uk» → «українська»).
 *
 * `Intl.DisplayNames` дає назви для всього списку кодів без власної таблиці; коли середовище не знає
 * мови чи не підтримує API, повертається сам код — це чесніше за вигадану назву.
 */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['uk'], { type: 'language' }).of(code)

    return name === undefined || name === code ? code : name
  } catch {
    return code
  }
}
