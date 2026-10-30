/**
 * BS-147: the name the home page greets a reader by — the first word of their display name, as they
 * wrote it (the nominative: «Вітаємо, Данило»). `null` when there is no word to greet by.
 */
export function greetingName(displayName: string): string | null {
  const [first] = displayName.trim().split(/\s+/)

  return first === undefined || first === '' ? null : first
}
