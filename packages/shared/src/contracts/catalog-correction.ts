import { z } from 'zod'
import { languageCodeSchema } from '../domain/language'
import {
  authorRoleSchema,
  catalogEntityTypeSchema,
  editionFormatSchema,
  editionTextKindSchema,
} from '../domain/catalog'
import {
  authorHasOneSource,
  AUTHOR_HAS_ONE_SOURCE_MESSAGE,
  CATALOG_LIMITS,
  createEditionRequestSchema,
  createTranslationRequestSchema,
  createWorkRequestSchema,
  editionResponseSchema,
  translationResponseSchema,
  workAuthorInputObjectSchema,
  workAuthorSchema,
  workSchema,
  type EditionResponse,
  type TranslationResponse,
} from './catalog'

/**
 * Stage 8e-1 (docs/plan/stage-8-inventory.md, R9/R10/R10a): shared contracts for
 * catalog metadata correction. The write path itself — permission checks,
 * conflict detection, audit writes — is 8e-2; this file only fixes the wire
 * shape both sides agree on, plus the shape `CatalogRevision.before`/`after`
 * validate against.
 */

/**
 * §6.3, R9: every `PATCH` names the revision it was read at. A stale client
 * gets `409 CATALOG_REVISION_CONFLICT` (see `errors.ts`) instead of a silent
 * overwrite — never `0` or negative, since `Work`/`Translation`/`Edition.revision`
 * starts at `1` and only increments.
 */
export const expectedRevisionSchema = z.number().int().positive()

// --- Запити --------------------------------------------------------------

/**
 * PO decision (Stage 8e-2, R10a — replaces the open choice `workAuthorInputObjectSchema`
 * used to leave to this write path): `authorId` (an existing author) and
 * `nameLatin` are mutually exclusive on one element, REJECTED with 400 — even
 * when `nameLatin` is explicitly `null`. `nameLatin` only means anything
 * paired with a NEW author's `name`; combined with `authorId` it would look
 * like a channel to edit that shared `Author` row's transliteration, which
 * R10 forbids. Rejecting (rather than silently dropping `nameLatin`) keeps
 * this consistent with every other "unknown/contradictory input" rule in this
 * PATCH — see the top-level `.strict()` and the client-supplied `position`
 * rejection below: this project never silently strips a field the client
 * explicitly sent.
 *
 * `authorId !== undefined` alone does not trigger this — only when `nameLatin`
 * is ALSO present as a key (string or `null`); a plain `{ authorId }` element
 * is unaffected.
 */
export const AUTHOR_ID_EXCLUDES_NAME_LATIN_MESSAGE =
  'nameLatin не редагує транслітерацію наявного автора — вкажіть його лише для нового автора (без authorId)'

export function authorIdExcludesNameLatin(value: {
  authorId?: string
  nameLatin?: string | null
}): boolean {
  return value.authorId === undefined || value.nameLatin === undefined
}

/**
 * Nested author input for PATCH — same fields as `workAuthorInputObjectSchema`
 * (create), but `.strict()`: unknown keys (notably a client-supplied
 * `position`, which R10a reserves for the server) are rejected, not silently
 * stripped. This is a PATCH-only tightening built off the shared object shape;
 * `workAuthorInputSchema` itself (create's schema) is untouched, so create's
 * existing strip-unknown-keys behavior does not change — the `authorId`/
 * `nameLatin` exclusion above is PATCH-only for the same reason: create has no
 * existing author whose transliteration this ambiguity could be mistaken for.
 */
const strictWorkAuthorInputSchema = workAuthorInputObjectSchema
  .strict()
  .refine(authorHasOneSource, AUTHOR_HAS_ONE_SOURCE_MESSAGE)
  .refine(authorIdExcludesNameLatin, AUTHOR_ID_EXCLUDES_NAME_LATIN_MESSAGE)

/**
 * `authors` — exactly what 8e-1 agreed on: omitted (undefined) means no
 * change; a supplied array is a full replacement per R10a (the server itself
 * assigns `position` from the elements' order, so an element does not accept
 * `position` as an input field); `null` and `[]` are both forbidden.
 *
 * The rest of the fields follow the exact same validation rules as create
 * (`createWorkRequestSchema`) — just optional. `.strict()` on the PATCH
 * object itself rejects any unknown top-level field (e.g. `workId`) instead
 * of silently stripping it, the same way `PatchWorkDto` does via
 * `forbidNonWhitelisted` (`catalog-correction.dto.ts`). This is PATCH-only:
 * `createWorkRequestSchema` keeps its existing strip behavior.
 */
export const workPatchRequestSchema = createWorkRequestSchema
  .partial()
  .extend({
    // `null` — мова оригіналу невідома (очищення). Видання при цьому не змінюються (ред. 2, §1).
    origLang: languageCodeSchema.nullable().optional(),
    authors: z
      .array(strictWorkAuthorInputSchema)
      .min(1, 'Потрібен хоча б один автор')
      .max(CATALOG_LIMITS.authorsMax)
      .optional(),
    expectedRevision: expectedRevisionSchema,
  })
  .strict()

export type WorkPatchRequest = z.infer<typeof workPatchRequestSchema>

export const translationPatchRequestSchema = createTranslationRequestSchema
  .partial()
  .extend({ expectedRevision: expectedRevisionSchema })
  .strict()

export type TranslationPatchRequest = z.infer<typeof translationPatchRequestSchema>

/** R10: `translationId` дозволений, але Translation мусить належати тому самому Work — 8e-2. */
export const editionPatchRequestSchema = createEditionRequestSchema
  .partial()
  .extend({
    // `null` — формат невідомий (очищення).
    format: editionFormatSchema.nullable().optional(),
    // Що відомо про текст видання й яка його мова — правила переходів у `edition-language.ts`.
    textKind: editionTextKindSchema.optional(),
    lang: languageCodeSchema.nullable().optional(),
    expectedRevision: expectedRevisionSchema,
  })
  .strict()

export type EditionPatchRequest = z.infer<typeof editionPatchRequestSchema>

// --- Відповіді -------------------------------------------------------------

/**
 * Work + його автори — саме те, що PATCH `/works/:id` міняє. Переклади й
 * видання не входять: PATCH метаданих Work їх не чіпає, а сторінка Work сама
 * лишається на `useWork()` (R12) як єдиному джерелі повного знімку.
 */
export const workPatchResponseSchema = z.object({
  work: workSchema,
  authors: z.array(workAuthorSchema),
})

export type WorkPatchResponse = z.infer<typeof workPatchResponseSchema>

/** Та сама форма, що й `POST .../translations` — оновлена сутність, нічого зайвого. */
export const translationPatchResponseSchema = translationResponseSchema

export type TranslationPatchResponse = TranslationResponse

/** Та сама форма, що й `POST .../editions`. */
export const editionPatchResponseSchema = editionResponseSchema

export type EditionPatchResponse = EditionResponse

// --- Знімки для CatalogRevision.before/after --------------------------------

/**
 * «Погоджені рішення» 8e-1: before/after — повні знімки РЕДАГОВАНИХ метаданих,
 * не публічна відповідь цілком. Жодних `ratingAvg`/`ratingCount`/`score`,
 * жодного `viewerCapabilities` — permissions і рейтинги сюди не копіюються.
 */
export const workRevisionAuthorSchema = z.object({
  authorId: z.string(),
  name: z.string(),
  /** Author-supplied transliteration (R10, `workAuthorInputSchema.nameLatin`) — part of the edited metadata, so the snapshot carries it too. */
  nameLatin: z.string().nullable(),
  role: authorRoleSchema,
  position: z.number().int().nonnegative(),
})

export type WorkRevisionAuthor = z.infer<typeof workRevisionAuthorSchema>

/** Для Work знімок включає авторські зв'язки та їхній порядок (R9). */
export const workRevisionSnapshotSchema = z.object({
  title: z.string(),
  /** `null` — мова оригіналу невідома. Старі знімки завжди мали рядок. */
  origLang: z.string().nullable(),
  firstPubYear: z.number().int().nullable(),
  description: z.string().nullable(),
  authors: z.array(workRevisionAuthorSchema),
})

export type WorkRevisionSnapshot = z.infer<typeof workRevisionSnapshotSchema>

export const translationRevisionSnapshotSchema = z.object({
  translator: z.string(),
  lang: z.string(),
  sourceLang: z.string(),
  year: z.number().int().nullable(),
  isAbridged: z.boolean(),
  hasNotes: z.boolean(),
  notes: z.string().nullable(),
})

export type TranslationRevisionSnapshot = z.infer<typeof translationRevisionSnapshotSchema>

export const editionRevisionSnapshotSchema = z.object({
  publisher: z.string().nullable(),
  year: z.number().int().nullable(),
  isbn13: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  format: editionFormatSchema.nullable(),
  translationId: z.string().nullable(),
  /**
   * Fast-add (docs/plan/fast-book-add.md, §4): тип тексту й мова видання. Опційні, бо знімки,
   * записані до цієї зміни, їх не мають; `textKind: null` — легасі-рядок до backfill.
   */
  textKind: editionTextKindSchema.nullable().optional(),
  lang: z.string().nullable().optional(),
})

export type EditionRevisionSnapshot = z.infer<typeof editionRevisionSnapshotSchema>

/**
 * Один запис на `CatalogEntityType` — 8e-2 обирає потрібну схему цим ключем
 * замість розкиданого по коду `switch`.
 */
export const catalogRevisionSnapshotSchemas = {
  WORK: workRevisionSnapshotSchema,
  TRANSLATION: translationRevisionSnapshotSchema,
  EDITION: editionRevisionSnapshotSchema,
} as const satisfies Record<z.infer<typeof catalogEntityTypeSchema>, z.ZodType>
