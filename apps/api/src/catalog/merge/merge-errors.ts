/**
 * Машиночитні коди відмов мержу (§6.3, підетап 7g).
 *
 * Живуть тут, а НЕ в `packages/shared` поряд із `API_ERROR_CODES`: мерж —
 * адмінська CLI-операція, а не ендпоінт (DoD 7g прямо забороняє публічний
 * маршрут). `API_ERROR_CODES` — контракт між API і `apps/web`, і засипати його
 * кодами, яких жоден HTTP-клієнт ніколи не побачить, означало б брехати про
 * поверхню API. Читач цих кодів один — оператор у терміналі й вихідний код
 * процесу.
 */
export const WORK_MERGE_ERROR_CODES = {
  /** Немає `Work` із таким id — вихідного, цільового або обох. */
  WORK_MERGE_WORK_NOT_FOUND: 'WORK_MERGE_WORK_NOT_FOUND',
  /** Вихідний і цільовий твір — той самий рядок. */
  WORK_MERGE_SELF: 'WORK_MERGE_SELF',
  /**
   * Вихідний твір уже змержений (`mergedIntoId != null`).
   *
   * Це те саме правило, яким відхиляється повторний мерж тієї самої пари, і воно
   * ж не дає збудувати ланцюг: якби A, уже злитий у B, дозволили злити ще й у C,
   * розв'язання канонічності перестало б бути одним кроком (R4).
   */
  WORK_MERGE_SOURCE_ALREADY_MERGED: 'WORK_MERGE_SOURCE_ALREADY_MERGED',
  /**
   * Цільовий твір уже змержений — мержити у неканонічний запис не можна (R4).
   *
   * Сюди ж потрапляє пряма спроба циклу: після `merge(A→B)` спроба `merge(B→A)`
   * бачить у цілі A вже проставлений `mergedIntoId`.
   */
  WORK_MERGE_TARGET_ALREADY_MERGED: 'WORK_MERGE_TARGET_ALREADY_MERGED',
  /**
   * Видання-оригінал вихідного твору має ВІДОМУ мову, відмінну від мови оригіналу цільового твору
   * (docs/plan/fast-book-add.md, ред. 2, §1). Перенос мовчки змінив би мову видання, а мову
   * цілі міняти злиттям не можна — тому злиття відхиляється й нічого не змінює. Виправіть мову видання
   * (PATCH видання) або мову оригіналу одного з творів і повторіть.
   */
  WORK_MERGE_LANGUAGE_CONFLICT: 'WORK_MERGE_LANGUAGE_CONFLICT',
} as const

export type WorkMergeErrorCode =
  (typeof WORK_MERGE_ERROR_CODES)[keyof typeof WORK_MERGE_ERROR_CODES]

/**
 * Відмова мержу з машиночитним кодом.
 *
 * Навмисно не `ApiException`: у неї обов'язковий HTTP-статус, а тут немає ні
 * запиту, ні відповіді — лише процес, який має завершитися ненульовим кодом.
 */
export class WorkMergeError extends Error {
  constructor(
    readonly code: WorkMergeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkMergeError'
  }
}
