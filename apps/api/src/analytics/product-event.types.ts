import { z } from 'zod'

/**
 * docs/plan/stage-8-activation.md, §4 — сім типів 8a; шість типів Етапу 9 додано нижче.
 *
 * На відміну від `NotificationType` (`packages/shared/src/domain/notification.ts`),
 * ця таксономія навмисно НЕ дублюється в Prisma-enum: `ProductEvent.type` — String
 * (schema.prisma), і живе повністю всередині `apps/api` (§2.5) — немає ні
 * ingestion-, ні read-endpoint, який виправдав би публічний контракт.
 */
export const PRODUCT_EVENT_TYPE = [
  'SIGNUP_COMPLETED',
  'BOOK_ADDED',
  'FRIEND_ACCEPTED',
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_HANDED_OVER',
  'LOAN_RETURNED',
  // Етап 9 (docs/plan/stage-9-network-activation.md, §2): мережа й пошук. Усі з
  // порожніми `properties` — без тексту запиту, назв і id книжок.
  'INVITE_SENT',
  'INVITE_ACCEPTED',
  'FRIEND_INVENTORY_USABLE',
  'DISCOVERY_SEARCHED',
  'FRIEND_BOOK_FOUND',
  'WORK_HOLDERS_FOUND',
] as const

export const productEventTypeSchema = z.enum(PRODUCT_EVENT_TYPE)

export type ProductEventType = z.infer<typeof productEventTypeSchema>

/** §4: усі типи, крім `BOOK_ADDED`, завжди мають порожні `properties`. */
const emptyPropertiesSchema = z.strictObject({})

/**
 * §4: у 8a завжди `'MANUAL'`. `BARCODE`/`CSV` уже в enum, щоб Stage 8b/8c не
 * мігрували схему — лише додали виклик з іншим значенням.
 */
export const bookAddedMethodSchema = z.enum(['MANUAL', 'BARCODE', 'CSV'])

const bookAddedPropertiesSchema = z.strictObject({ method: bookAddedMethodSchema })

/** `properties` за типом події — використовується і для runtime-валідації, і для тестів. */
export const PRODUCT_EVENT_PROPERTIES_SCHEMA = {
  SIGNUP_COMPLETED: emptyPropertiesSchema,
  BOOK_ADDED: bookAddedPropertiesSchema,
  FRIEND_ACCEPTED: emptyPropertiesSchema,
  LOAN_REQUESTED: emptyPropertiesSchema,
  LOAN_APPROVED: emptyPropertiesSchema,
  LOAN_HANDED_OVER: emptyPropertiesSchema,
  LOAN_RETURNED: emptyPropertiesSchema,
  INVITE_SENT: emptyPropertiesSchema,
  INVITE_ACCEPTED: emptyPropertiesSchema,
  FRIEND_INVENTORY_USABLE: emptyPropertiesSchema,
  DISCOVERY_SEARCHED: emptyPropertiesSchema,
  FRIEND_BOOK_FOUND: emptyPropertiesSchema,
  WORK_HOLDERS_FOUND: emptyPropertiesSchema,
} as const satisfies Record<ProductEventType, z.ZodTypeAny>

/**
 * §6: discriminated union — `properties` мусить відповідати `type`, а
 * `subjectUserId`/`domainEntityId` обов'язкові для кожної події 8a.
 * `domainEntityId` йде лише як вхід `dedupeKey` (`dedupe-key.ts`) і ніколи не
 * потрапляє в сам рядок `ProductEvent` (§2.2). `subjectUserId` — інакше: він
 * теж входить у `dedupeKey`, але, на відміну від `domainEntityId`, ще й
 * зберігається в `ProductEvent.subjectUserId` як nullable FK на `User`
 * (`onDelete: SetNull`, §2.1, §5 AnalyticsService.record).
 *
 * `z.strictObject` на кожній гілці — щоб зайве поле (наприклад, випадково
 * передане `loanId`) відхилялося, а не мовчки ігнорувалося.
 */
function eventSchema<T extends ProductEventType, P extends z.ZodTypeAny>(type: T, properties: P) {
  return z.strictObject({
    type: z.literal(type),
    subjectUserId: z.string().min(1),
    domainEntityId: z.string().min(1),
    properties,
  })
}

export const productEventInputSchema = z.discriminatedUnion('type', [
  eventSchema('SIGNUP_COMPLETED', PRODUCT_EVENT_PROPERTIES_SCHEMA.SIGNUP_COMPLETED),
  eventSchema('BOOK_ADDED', PRODUCT_EVENT_PROPERTIES_SCHEMA.BOOK_ADDED),
  eventSchema('FRIEND_ACCEPTED', PRODUCT_EVENT_PROPERTIES_SCHEMA.FRIEND_ACCEPTED),
  eventSchema('LOAN_REQUESTED', PRODUCT_EVENT_PROPERTIES_SCHEMA.LOAN_REQUESTED),
  eventSchema('LOAN_APPROVED', PRODUCT_EVENT_PROPERTIES_SCHEMA.LOAN_APPROVED),
  eventSchema('LOAN_HANDED_OVER', PRODUCT_EVENT_PROPERTIES_SCHEMA.LOAN_HANDED_OVER),
  eventSchema('LOAN_RETURNED', PRODUCT_EVENT_PROPERTIES_SCHEMA.LOAN_RETURNED),
  eventSchema('INVITE_SENT', PRODUCT_EVENT_PROPERTIES_SCHEMA.INVITE_SENT),
  eventSchema('INVITE_ACCEPTED', PRODUCT_EVENT_PROPERTIES_SCHEMA.INVITE_ACCEPTED),
  eventSchema('FRIEND_INVENTORY_USABLE', PRODUCT_EVENT_PROPERTIES_SCHEMA.FRIEND_INVENTORY_USABLE),
  eventSchema('DISCOVERY_SEARCHED', PRODUCT_EVENT_PROPERTIES_SCHEMA.DISCOVERY_SEARCHED),
  eventSchema('FRIEND_BOOK_FOUND', PRODUCT_EVENT_PROPERTIES_SCHEMA.FRIEND_BOOK_FOUND),
  eventSchema('WORK_HOLDERS_FOUND', PRODUCT_EVENT_PROPERTIES_SCHEMA.WORK_HOLDERS_FOUND),
])

export type ProductEventInput = z.infer<typeof productEventInputSchema>
