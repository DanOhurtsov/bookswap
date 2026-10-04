import type { Visibility } from '@bookswap/shared'

/**
 * §9: видимість примірника = найсуворіше з видимості бібліотеки та самого примірника.
 *
 * Дзеркало серверного `strictestVisibility` лише для ПОЯСНЕННЯ в панелі налаштувань: рішення про
 * доступ завжди ухвалює сервер. Тут немає жодного місця, де клієнт щось дозволяє чи забороняє.
 */
const STRICTNESS: Readonly<Record<Visibility, number>> = { PUBLIC: 0, FRIENDS: 1, PRIVATE: 2 }

export function effectiveVisibility(library: Visibility, copy: Visibility): Visibility {
  return STRICTNESS[library] >= STRICTNESS[copy] ? library : copy
}

const AUDIENCE: Readonly<Record<Visibility, string>> = {
  PUBLIC: 'будь-хто',
  FRIENDS: 'ваші друзі',
  PRIVATE: 'лише ви',
}

/** Текст «Хто бачить цей примірник», з поясненням, коли суворіше обмеження діє від бібліотеки. */
export function describeEffectiveVisibility(library: Visibility, copy: Visibility): string {
  const effective = effectiveVisibility(library, copy)
  const base = `Бачить: ${AUDIENCE[effective]}.`

  if (effective === library && library !== copy) {
    return `${base} Суворіше обмеження вашої бібліотеки діє першим: вибране для примірника значення його не відкриває.`
  }

  return base
}
