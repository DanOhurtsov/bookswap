import type { EditionTextKind } from '@bookswap/shared'

/**
 * Правила мови й типу тексту видання (docs/plan/fast-book-add.md, §4, ред. 2, §1).
 *
 * Усе тут — чисті функції без Prisma: правило одне, і його викликають створення видання, PATCH
 * видання, каскади від зміни мови перекладу й твору, злиття творів. Введені дані ніколи не
 * відкидаються мовчки: суперечність — це явний результат `conflict`, який викликач перетворює на
 * зрозумілу помилку й відкат усієї операції.
 *
 * Інваріанти:
 * - **I1** (CHECK у БД): є зв'язок з перекладом ⇒ `textKind = TRANSLATION`.
 * - **I2**: є зв'язок з перекладом ⇒ `lang` видання = `Translation.lang`.
 * - **I3**: `textKind = ORIGINAL` і `Work.origLang` відома ⇒ `lang` = `Work.origLang`.
 */

/**
 * Тип тексту й мова видання — ВЛАСНІ поля рядка, а не висновок із відсутності перекладу чи з твору.
 * Легасі-рядки отримали їх міграцією C2 (backfill зі старої семантики).
 */
export interface EditionTextRow {
  textKind: EditionTextKind
  lang: string | null
}

export interface EditionTextState {
  textKind: EditionTextKind
  lang: string | null
  translationId: string | null
}

/** Поля запиту; `undefined` — «не передано, не чіпати». */
export interface EditionTextPatch {
  textKind?: EditionTextKind
  lang?: string | null
  translationId?: string | null
}

export interface EditionTextContext {
  /** Мова оригіналу твору, до якого належить видання (`null` — невідома). */
  workOrigLang: string | null
  /** Переклад, на який вказує `patch.translationId` (обов'язковий, коли він не `null`). */
  targetTranslation?: { lang: string }
  /** Переклад, з яким видання пов'язане зараз (для заміни одного перекладу іншим). */
  currentTranslation?: { lang: string } | null
}

export type EditionTextResolution =
  | { ok: true; state: EditionTextState }
  | {
      ok: false
      reason: 'LANGUAGE_CONFLICT' | 'KIND_REQUIRES_UNLINK' | 'UNLINK_NEEDS_KIND'
      message: string
    }

/** Мова, яку попередній стан видання виводив сам: переклад → його мова, оригінал → мова твору. */
function impliedLang(from: EditionTextState, context: EditionTextContext): string | null {
  if (from.translationId !== null) return context.currentTranslation?.lang ?? null
  if (from.textKind === 'ORIGINAL') return context.workOrigLang

  return null
}

const NEW_EDITION: EditionTextState = { textKind: 'UNKNOWN', lang: null, translationId: null }

/**
 * Переходи UNKNOWN ↔ ORIGINAL ↔ TRANSLATION, прив'язування й відв'язування перекладу.
 * `current` не передано — створення нового видання («порожній» початковий стан).
 */
export function resolveEditionText(
  current: EditionTextState | undefined,
  patch: EditionTextPatch,
  context: EditionTextContext,
): EditionTextResolution {
  const from = current ?? NEW_EDITION
  const next: EditionTextState = {
    textKind: patch.textKind ?? from.textKind,
    lang: patch.lang === undefined ? from.lang : patch.lang,
    translationId: patch.translationId === undefined ? from.translationId : patch.translationId,
  }

  if (next.translationId !== null) {
    if (patch.textKind !== undefined && patch.textKind !== 'TRANSLATION') {
      return {
        ok: false,
        reason: 'KIND_REQUIRES_UNLINK',
        message:
          'Видання з привʼязаним перекладом — це переклад; щоб змінити тип тексту, відвʼяжіть переклад',
      }
    }

    const target = context.targetTranslation

    if (target === undefined) throw new Error('Для привʼязаного перекладу потрібна його мова')

    next.textKind = 'TRANSLATION'

    // Мова, яку видання мало лише ЗАВДЯКИ попередньому стану (мова оригіналу твору для оригіналу, мова
    // попереднього перекладу), — не введена людиною, а виведена (I2/I3). Нею не можна блокувати новий
    // зв'язок: мова слідує за перекладом. Мова, що відрізняється від виведеної, — відома незалежно
    // (від зовнішнього джерела чи з руки) і, коли суперечить перекладу, дає явний конфлікт.
    if (
      patch.lang === undefined &&
      from.lang !== null &&
      from.lang === impliedLang(from, context)
    ) {
      next.lang = target.lang
    }

    if (next.lang === null) next.lang = target.lang
    else if (next.lang !== target.lang) {
      return {
        ok: false,
        reason: 'LANGUAGE_CONFLICT',
        message: `Мова видання (${next.lang}) не збігається з мовою перекладу (${target.lang})`,
      }
    }

    return { ok: true, state: next }
  }

  if (from.translationId !== null && patch.translationId === null) {
    // Відв'язування. Без явного типу тексту — стара семантика «немає перекладу = оригінал»,
    // але лише коли мова оригіналу відома: інакше це вигадування.
    if (patch.textKind === undefined) {
      if (context.workOrigLang === null) {
        return {
          ok: false,
          reason: 'UNLINK_NEEDS_KIND',
          message:
            'Мова оригіналу твору невідома — вкажіть, що відомо про текст видання (textKind)',
        }
      }

      next.textKind = 'ORIGINAL'

      if (patch.lang === undefined) next.lang = context.workOrigLang
    }
  } else if (
    from.translationId !== null &&
    patch.textKind !== undefined &&
    patch.textKind !== 'TRANSLATION'
  ) {
    return {
      ok: false,
      reason: 'KIND_REQUIRES_UNLINK',
      message:
        'Щоб змінити тип тексту видання з перекладу, відвʼяжіть переклад (translationId: null)',
    }
  }

  if (next.textKind === 'ORIGINAL' && context.workOrigLang !== null) {
    if (next.lang === null) next.lang = context.workOrigLang
    else if (next.lang !== context.workOrigLang) {
      return {
        ok: false,
        reason: 'LANGUAGE_CONFLICT',
        message: `Мова видання (${next.lang}) не збігається з мовою оригіналу твору (${context.workOrigLang})`,
      }
    }
  }

  return { ok: true, state: next }
}

export interface EditionLangFacts {
  id: string
  /** Ефективний тип тексту (легасі виводиться за `kindOf`). */
  kind: EditionTextKind
  /** Ефективна мова видання. */
  lang: string | null
}

export type CascadePlan =
  | { ok: true; updates: { id: string; lang: string }[] }
  | { ok: false; conflictEditionIds: string[] }

/**
 * Зміна `Work.origLang` з `oldLang` на `newLang`: що станеться з виданнями-оригіналами.
 *
 * Мова видання, що дорівнює новій, лишається; невідома — заповнюється новою; дорівнює колишній мові
 * оригіналу — переходить на нову. Будь-яка інша відома мова — конфлікт: нічого не змінюється
 * (викликач відкочує всю операцію). Очищення мови оригіналу видань не торкається.
 */
export function planWorkOriginalLangChange(
  editions: readonly EditionLangFacts[],
  oldLang: string | null,
  newLang: string | null,
): CascadePlan {
  if (newLang === null) return { ok: true, updates: [] }

  const updates: { id: string; lang: string }[] = []
  const conflictEditionIds: string[] = []

  for (const edition of editions) {
    if (edition.kind !== 'ORIGINAL' || edition.lang === newLang) continue

    if (edition.lang === null || (oldLang !== null && edition.lang === oldLang)) {
      updates.push({ id: edition.id, lang: newLang })
    } else {
      conflictEditionIds.push(edition.id)
    }
  }

  return conflictEditionIds.length > 0 ? { ok: false, conflictEditionIds } : { ok: true, updates }
}

export type MergeLanguageAction =
  { action: 'KEEP' } | { action: 'SET'; lang: string | null } | { action: 'CONFLICT' }

/**
 * Видання-оригінал при злитті творів: що з його мовою, якщо мова оригіналу цільового твору інша.
 * Видання-переклади й `UNKNOWN` переносяться без змін.
 *
 * - ціль без відомої мови: мова видання лишається своєю (вона не виводиться з твору);
 * - ціль має мову, видання — невідому: заповнюємо мовою цілі;
 * - збіг: без змін; різні відомі мови: КОНФЛІКТ — злиття відхиляється, мову не міняють мовчки.
 */
export function planMergeLanguage(
  edition: EditionLangFacts,
  targetOrigLang: string | null,
): MergeLanguageAction {
  if (edition.kind !== 'ORIGINAL') return { action: 'KEEP' }

  if (targetOrigLang === null) return { action: 'KEEP' }
  if (edition.lang === null) return { action: 'SET', lang: targetOrigLang }
  if (edition.lang === targetOrigLang) return { action: 'KEEP' }

  return { action: 'CONFLICT' }
}

/**
 * Умови Prisma для фільтрів за мовою й типом тексту (бібліотека, мережа, «Хто має цю книжку?»).
 * `UNKNOWN` не є ні оригіналом, ні перекладом; видання без мови не потрапляє в жоден мовний фільтр.
 */
export function editionLanguageWhere(lang: string): object {
  return { lang }
}

/** `ORIGINAL` — оригінал; `TRANSLATED` — переклад (зі зв'язком чи без). `UNKNOWN` не є жодним із двох. */
export function editionKindWhere(kind: 'ORIGINAL' | 'TRANSLATED'): object {
  return { textKind: kind === 'ORIGINAL' ? 'ORIGINAL' : 'TRANSLATION' }
}
