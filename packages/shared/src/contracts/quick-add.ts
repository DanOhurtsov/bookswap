import { z } from 'zod'
import { conditionSchema } from '../domain/copy'
import { visibilitySchema } from '../domain/visibility'
import { editionFormatSchema, editionTextKindSchema } from '../domain/catalog'
import { isbn13Schema } from '../domain/isbn'
import { languageCodeSchema } from '../domain/language'
import {
  CATALOG_LIMITS,
  createEditionRequestSchema,
  createTranslationRequestSchema,
  createWorkRequestSchema,
  editionSchema,
  workAuthorInputSchema,
  workAuthorSchema,
  workSchema,
} from './catalog'
import { copyEntryMethodSchema, LIBRARY_LIMITS, ownCopySchema } from './library'

/**
 * Швидке додавання книжки (docs/plan/fast-book-add.md, §5): `POST /me/library/quick-add`.
 *
 * Одна дія користувача — одна серверна операція. `operationId` ідентифікує саме
 * НАМІР: мережевий повтор тієї самої дії несе той самий ключ і той самий вміст,
 * а свідоме «ще один примірник» — новий ключ. Власника визначає сесія, тому
 * `ownerId` у запиті немає й бути не може.
 *
 * Схеми `strict`: невідоме поле — це клієнт, що вважає, ніби сервер щось зробить,
 * а він мовчки проігнорує (так само, як у решті DTO бібліотеки).
 */

export const QUICK_ADD_TARGET_KIND = ['EXISTING_EDITION', 'EXTERNAL_EDITION', 'MANUAL'] as const

export const quickAddTargetKindSchema = z.enum(QUICK_ADD_TARGET_KIND)

export type QuickAddTargetKind = z.infer<typeof quickAddTargetKindSchema>

const idSchema = z.string().trim().min(1).max(LIBRARY_LIMITS.idMax)

/**
 * Персональні значення нового примірника. Усе необов'язкове: стан за замовчуванням
 * `GOOD`, видимість визначає сервер із налаштувань профілю, коли користувач її не
 * задав (`strictest(libraryVisibility, FRIENDS)`).
 */
export const quickAddCopySchema = z.strictObject({
  condition: conditionSchema.optional(),
  note: z.string().trim().max(LIBRARY_LIMITS.noteMax).nullable().optional(),
  visibility: visibilitySchema.optional(),
  acquiredAt: z.iso.date().nullable().optional(),
})

export type QuickAddCopy = z.infer<typeof quickAddCopySchema>

/** Видання, яке вже є в нашому каталозі. */
export const quickAddExistingEditionTargetSchema = z.strictObject({
  kind: z.literal('EXISTING_EDITION'),
  editionId: idSchema,
})

export type QuickAddExistingEditionTarget = z.infer<typeof quickAddExistingEditionTargetSchema>

/**
 * Видання із зовнішнього джерела, яке вперше потрапляє в наш каталог (або вже там є).
 *
 * Ідентичність — ISBN-13 і/або зовнішній запис `(source, externalId)`. Метадані з клієнта НЕ приймаються:
 * сервер сам бере їх у джерела (до транзакції), а коли видання вже відоме локально — зовсім обходиться без
 * джерела. Зараз зовнішній запис адресується для Google Books (том за id); решта — через ISBN.
 */
export const QUICK_ADD_EXTERNAL_SOURCES = ['GOOGLE_BOOKS'] as const

export const quickAddExternalSourceSchema = z.enum(QUICK_ADD_EXTERNAL_SOURCES)

export const quickAddExternalEditionTargetSchema = z
  .strictObject({
    kind: z.literal('EXTERNAL_EDITION'),
    isbn13: isbn13Schema.optional(),
    source: quickAddExternalSourceSchema.optional(),
    externalId: z.string().trim().min(1).max(LIBRARY_LIMITS.idMax).optional(),
  })
  .superRefine((value, context) => {
    if ((value.source === undefined) !== (value.externalId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['externalId'],
        message: 'source і externalId задаються разом',
      })
    }

    if (value.isbn13 === undefined && value.externalId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['isbn13'],
        message: 'Потрібен ISBN-13 або пара source + externalId',
      })
    }
  })

export type QuickAddExternalEditionTarget = z.infer<typeof quickAddExternalEditionTargetSchema>

/**
 * Ручне додавання: ОДНА компактна форма (docs/plan/fast-book-add.md, §2.4). Обов'язкова лише назва нового
 * твору; невідомі автор, мова, ISBN і видавничі дані лишаються невідомими й уточнюються пізніше.
 *
 * Твір — або наявний (`workId`), або новий. Новий не вигадує нічого: без авторів (`authors` порожній),
 * без мови оригіналу (`origLang: null`), без року першого видання. Переклад необов'язковий: порожній розділ
 * нічого не створює, заповнений — проходить чинну перевірку своїх полів.
 *
 * `textKind` — що відомо про текст видання (ORIGINAL / TRANSLATION / UNKNOWN), явно. Мова видання не
 * доводить мови оригіналу, а відсутність перекладу не доводить, що це оригінал.
 */
export const quickAddManualWorkSchema = z.union([
  z.strictObject({ workId: idSchema }),
  createWorkRequestSchema
    .omit({ origLang: true, authors: true })
    .extend({
      origLang: languageCodeSchema.nullable().optional(),
      authors: z.array(workAuthorInputSchema).max(CATALOG_LIMITS.authorsMax).optional(),
    })
    .strict(),
])

export const quickAddManualEditionSchema = createEditionRequestSchema
  .omit({ translationId: true, format: true })
  .extend({
    textKind: editionTextKindSchema,
    lang: languageCodeSchema.nullable().optional(),
    format: editionFormatSchema.nullable().optional(),
  })
  .strict()

export const quickAddManualTargetSchema = z.strictObject({
  kind: z.literal('MANUAL'),
  work: quickAddManualWorkSchema,
  edition: quickAddManualEditionSchema,
  translation: createTranslationRequestSchema.strict().optional(),
})

export type QuickAddManualTarget = z.infer<typeof quickAddManualTargetSchema>

export const quickAddTargetSchema = z.discriminatedUnion('kind', [
  quickAddExistingEditionTargetSchema,
  quickAddExternalEditionTargetSchema,
  quickAddManualTargetSchema,
])

export type QuickAddTarget = z.infer<typeof quickAddTargetSchema>

export const quickAddRequestSchema = z.strictObject({
  /** UUID однієї дії користувача; зберігається між мережевими повторами. */
  operationId: z.uuid(),
  entryMethod: copyEntryMethodSchema.optional(),
  copy: quickAddCopySchema.optional(),
  target: quickAddTargetSchema,
})

export type QuickAddRequest = z.infer<typeof quickAddRequestSchema>

/**
 * `replayed: true` — це відповідь на повтор уже виконаної операції: примірник той
 * самий, нового не створено. Клієнт показує однаковий успіх в обох випадках.
 */
export const quickAddResponseSchema = z.object({
  operationId: z.uuid(),
  replayed: z.boolean(),
  copy: ownCopySchema,
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
})

export type QuickAddResponse = z.infer<typeof quickAddResponseSchema>
