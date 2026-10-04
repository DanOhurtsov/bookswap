import { z } from 'zod'

/**
 * §4.4, enum'и каталогу.
 *
 * Як `Visibility` і `FriendshipStatus`, значення дублюють Prisma-enum'и з
 * `apps/api`: `packages/shared` не має права залежати від згенерованого клієнта
 * (§12.1). Розсинхрон ловиться на боці API — див.
 * `apps/api/src/common/enum-parity.spec.ts`.
 */
export const AUTHOR_ROLE = ['AUTHOR', 'CO_AUTHOR', 'EDITOR', 'ILLUSTRATOR'] as const

export const authorRoleSchema = z.enum(AUTHOR_ROLE)

export type AuthorRole = z.infer<typeof authorRoleSchema>

export const EDITION_FORMAT = ['HARDCOVER', 'PAPERBACK', 'POCKET'] as const

export const editionFormatSchema = z.enum(EDITION_FORMAT)

export type EditionFormat = z.infer<typeof editionFormatSchema>

/**
 * Що відомо про текст видання (docs/plan/fast-book-add.md, §4): оригінал, переклад чи невідомо.
 *
 * `translationId = null` ЛИШЕ означає «немає зв'язку з конкретним `Translation`» — оригіналом видання
 * його не робить. Мова видання (`Edition.lang`) теж окремий факт: вона не доводить мови оригіналу.
 */
export const EDITION_TEXT_KIND = ['ORIGINAL', 'TRANSLATION', 'UNKNOWN'] as const

export const editionTextKindSchema = z.enum(EDITION_TEXT_KIND)

export type EditionTextKind = z.infer<typeof editionTextKindSchema>

/**
 * Stage 8e-1, R9: which catalog entity a `CatalogRevision` audit row describes.
 * Mirrors the Prisma enum `CatalogEntityType` — parity checked the same way as
 * the enums above (`apps/api/src/common/enum-parity.spec.ts`).
 */
export const CATALOG_ENTITY_TYPE = ['WORK', 'TRANSLATION', 'EDITION'] as const

export const catalogEntityTypeSchema = z.enum(CATALOG_ENTITY_TYPE)

export type CatalogEntityType = z.infer<typeof catalogEntityTypeSchema>
