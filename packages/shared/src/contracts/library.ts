import { z } from 'zod'
import { conditionSchema, copyStatusSchema, ownerCopyStatusSchema } from '../domain/copy'
import { languageCodeSchema } from '../domain/language'
import { exclusiveLoanStatusSchema, openLoanStatusSchema } from '../domain/loan'
import { visibilitySchema } from '../domain/visibility'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { publicUserSchema } from './user'

/**
 * §6.4–6.5 і §8, блок «Бібліотека».
 *
 * Три проєкції примірника, а не одна з опційними полями. Це не дублювання: вони
 * відповідають на різні питання — «моя книжка», «книжка друга, яку мені видно» і
 * «чужа книжка, що зараз у мене». §9 вимагає, щоб приватне не віддавалося з API,
 * а не ховалося в UI, і єдиний спосіб це гарантувати — щоб приватного поля просто
 * не існувало у відповідній схемі.
 */

export const LIBRARY_LIMITS = {
  noteMax: 1000,
  idMax: 64,
  queryMin: 2,
  queryMax: 200,
} as const

export const COPY_ENTRY_METHOD = ['MANUAL', 'BARCODE'] as const

export const copyEntryMethodSchema = z.enum(COPY_ENTRY_METHOD)

export type CopyEntryMethod = z.infer<typeof copyEntryMethodSchema>

const idSchema = z.string().trim().min(1).max(LIBRARY_LIMITS.idMax)

const noteSchema = z.string().trim().max(LIBRARY_LIMITS.noteMax)

/**
 * Календарний день без часу — в обидва боки.
 *
 * У базі це `DateTime`, але «о котрій годині ви купили книжку» чи «о котрій
 * повернути» не означає нічого. Віддавати повний ISO означало б змусити форму
 * його різати, а потім гадати про часовий пояс: 2026-08-15T00:00Z у Києві — це
 * вже 15 серпня о третій ночі, і при зворотному перетворенні дата стрибнула б
 * на день.
 *
 * Спільна для `acquiredAt` і `expectedReturnAt`: правило одне, і дві його копії
 * розійшлися б при першій же зміні.
 */
const dateOnlySchema = z.iso.date()

// --- Контекст позичання -------------------------------------------------------

/**
 * Лоан **того, хто дивиться**, на цей примірник.
 *
 * Існує тому, що `Copy.status` на це питання не відповідає: за §5.1 перехід
 * `— → REQUESTED` примірника не змінює взагалі, тож після надісланого запиту
 * книжка лишається `AVAILABLE`. Інтерфейс, який малює кнопку «Попросити» за
 * самим лише статусом, дозволив би натиснути її вдруге й отримати 409
 * `LOAN_DUPLICATE_REQUEST` — помилку, яку клієнт мав знати наперед.
 *
 * Таких лоанів завжди не більше одного: `REQUESTED` вимагає `AVAILABLE`,
 * `APPROVED` робить примірник `RESERVED`, а другий ексклюзивний блокує
 * `one_active_loan_per_copy` (§5.3.1).
 */
export const viewerLoanSchema = z.object({
  id: z.string(),
  status: openLoanStatusSchema,
})

export type ViewerLoan = z.infer<typeof viewerLoanSchema>

/**
 * Ексклюзивний лоан на власному примірнику — той єдиний, що займає книжку.
 *
 * Окрема схема, а не `viewerLoanSchema`: питання інше. Власнику потрібно «хто
 * саме зараз тримає домовленість», і на це є рівно одна відповідь (§5.3.1).
 * Скільки людей стоїть у черзі — окреме число `pendingRequestCount`, бо
 * `REQUESTED` на примірнику може бути кілька (§5.2), і зводити обидва питання
 * до одного `activeLoanId` означало б віддати id, який відповідає не на те.
 */
export const ownerLoanSchema = z.object({
  id: z.string(),
  status: exclusiveLoanStatusSchema,
  /** Позичальник: власник бачить імена завжди (§6.6). */
  counterpart: publicUserSchema,
})

export type OwnerLoan = z.infer<typeof ownerLoanSchema>

// --- Проєкції примірника ------------------------------------------------------

/** Власний примірник: видно все, включно з приватною нотаткою. */
export const ownCopySchema = z.object({
  id: z.string(),
  status: copyStatusSchema,
  visibility: visibilitySchema,
  condition: conditionSchema,
  note: z.string().nullable(),
  acquiredAt: dateOnlySchema.nullable(),
  createdAt: z.iso.datetime(),
  /** `currentHolderId === ownerId` — інваріант §5.3.2 в термінах інтерфейсу. */
  isHome: z.boolean(),
  /** Хто тримає, якщо не вдома. Власник бачить імена завжди (§6.6). */
  holder: publicUserSchema.nullable(),
  /** Єдиний `APPROVED`/`HANDED_OVER` на цьому примірнику, якщо він є. */
  activeLoan: ownerLoanSchema.nullable(),
  /** Скільки запитів чекає на відповідь. §5.2 дозволяє кілька одночасно. */
  pendingRequestCount: z.number().int().nonnegative(),
})

export type OwnCopy = z.infer<typeof ownCopySchema>

/**
 * Примірник у бібліотеці іншої людини.
 *
 * Немає `note`, `acquiredAt` і `visibility` — це приватне власника. `holder`
 * зʼявляється лише коли `holderNamesVisibleTo` дозволив (§6.6); інакше лишається
 * `null`, і видно тільки статус.
 */
export const visibleCopySchema = z.object({
  id: z.string(),
  status: copyStatusSchema,
  condition: conditionSchema,
  isHome: z.boolean(),
  holder: publicUserSchema.nullable(),
  /**
   * §6.5, кнопка «Попросити». Лоан **того, хто дивиться**, і нічий більше:
   * скільки ще людей стоїть у черзі — не його справа.
   */
  myActiveLoan: viewerLoanSchema.nullable(),
  /**
   * §6.5 і §9: чи може **цей** глядач попросити **цей** примірник просто зараз.
   *
   * Рахує сервер, і це не зручність. `/users/:id/library` віддає бібліотеку не
   * лише другові: за §9 `PUBLIC`-полицю бачить будь-хто, а власник бачить свою
   * завжди. `status = AVAILABLE` тому не означає «кнопку можна малювати» — для
   * стороннього вона дасть 403, для власника 400 `LOAN_SELF`, а для того, хто
   * вже попросив, 409. Кнопка, що гарантовано не спрацює, гірша за її відсутність.
   *
   * Клієнт **не** обчислює це сам: дружба й видимість — авторизаційні правила
   * §9, і друга їх реалізація в браузері однаково не мала б доступу до потрібних
   * даних, зате розійшлася б із першою.
   *
   * `true` лише коли виконано все: роль `FRIEND`, примірник видимий,
   * `status = AVAILABLE`, книжка вдома, глядач не власник і не має власного
   * незавершеного лоану на цей примірник.
   */
  canRequest: z.boolean(),
  /**
   * §6.5: «Для `RESERVED` / `LENT_OUT` — орієнтовна дата повернення, якщо
   * власник її вказав».
   *
   * Дата й **тільки** дата: ні `borrowerId`, ні `loanId`, ні вкладених обʼєктів.
   * Вона — факт про книжку («звільниться приблизно тоді»), а не про людину, тому
   * §6.6 її не приховує. Але й розкривати через неї більше, ніж вона є, не можна:
   * саме тому це окреме поле, а не вкладений лоан із «лише потрібними» полями.
   */
  expectedReturnAt: dateOnlySchema.nullable(),
})

export type VisibleCopy = z.infer<typeof visibleCopySchema>

/**
 * Чужий примірник, що зараз у мене (§6.4, «Чужі книжки в мене»).
 *
 * Власника видно завжди — інакше незрозуміло, кому повертати. Нотатки власника —
 * ні: те, що книжка в мене, не дає доступу до його записів про неї.
 */
export const borrowedCopySchema = z.object({
  id: z.string(),
  status: copyStatusSchema,
  condition: conditionSchema,
  owner: publicUserSchema,
  /** Лоан, яким книжка опинилася тут: сторінка веде саме на нього. */
  activeLoan: viewerLoanSchema.nullable(),
})

export type BorrowedCopy = z.infer<typeof borrowedCopySchema>

// --- Групи --------------------------------------------------------------------

/**
 * §6.4: «Шантарам ×3 · 2 вдома, 1 у Марка».
 *
 * Групування за виданням — подання, а не модель: окремі `Copy` лишаються в
 * `copies` поштучно. Кількість — це `COUNT` рядків, а не поле `quantity` (§3).
 */
export const libraryCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  home: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
})

export type LibraryCounts = z.infer<typeof libraryCountsSchema>

export const libraryGroupSchema = z.object({
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  copies: z.array(ownCopySchema),
  counts: libraryCountsSchema,
})

export type LibraryGroup = z.infer<typeof libraryGroupSchema>

/**
 * Те саме для чужої бібліотеки. Лічильники рахують **лише видимі** примірники.
 *
 * `inWishlist` — §6.5: «Позначка, які з них у вішлисті користувача». Рахує
 * сервер за твором (`Work`), а не за примірником: вішлист адресує `Work`
 * (`WishlistItem.workId`), тож мітка одна на групу, а не на кожен `Copy`.
 */
export const visibleLibraryGroupSchema = z.object({
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  copies: z.array(visibleCopySchema),
  counts: libraryCountsSchema,
  inWishlist: z.boolean(),
})

export type VisibleLibraryGroup = z.infer<typeof visibleLibraryGroupSchema>

export const borrowedLibraryGroupSchema = z.object({
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  copies: z.array(borrowedCopySchema),
  counts: libraryCountsSchema,
})

export type BorrowedLibraryGroup = z.infer<typeof borrowedLibraryGroupSchema>

// --- Запити -------------------------------------------------------------------

/**
 * §8: `?status=&lang=&q=`.
 *
 * `lang` — мова видання: `Translation.lang`, а для видання мовою оригіналу —
 * `Work.origLang`. Різниця не косметична: том англійською в оригіналі й том
 * англійського перекладу з японської — це різні речі на полиці.
 */
export const libraryQueryRequestSchema = z.object({
  status: copyStatusSchema.optional(),
  /** Stage 10 (10c): `true` — лише архів власника; без параметра чи `false` — активні примірники. */
  archived: z.enum(['true', 'false']).optional(),
  lang: languageCodeSchema.optional(),
  q: z.string().trim().min(LIBRARY_LIMITS.queryMin).max(LIBRARY_LIMITS.queryMax).optional(),
})

export type LibraryQueryRequest = z.infer<typeof libraryQueryRequestSchema>

/**
 * §8: `POST /me/library { editionId, condition, note, visibility, entryMethod? }`.
 *
 * Кожен фізичний примірник — окремий рядок, тож поля «скільки» тут немає й бути
 * не може (§3). Два однакові томи — два запити. `entryMethod` класифікує канал
 * активації для аналітики й не впливає на permission-рішення.
 */
export const addCopyRequestSchema = z.object({
  editionId: idSchema,
  condition: conditionSchema.optional(),
  note: noteSchema.nullable().optional(),
  visibility: visibilitySchema.optional(),
  acquiredAt: dateOnlySchema.nullable().optional(),
  entryMethod: copyEntryMethodSchema.optional(),
})

export type AddCopyRequest = z.infer<typeof addCopyRequestSchema>

/**
 * §6.4: редагування примірника.
 *
 * `status` звужений до `ownerCopyStatusSchema`: `RESERVED` і `LENT_OUT` виникають
 * лише з переходів §5.1, тож клієнт не може їх надіслати в принципі — вони
 * відпадають на валідації, а не на бізнес-перевірці. Решта полів не залежить від
 * стану лоану: нотатка про стан книжки потрібна власнику саме тоді, коли її
 * хтось тримає.
 */
export const updateCopyRequestSchema = z
  .object({
    condition: conditionSchema,
    note: noteSchema.nullable(),
    visibility: visibilitySchema,
    acquiredAt: dateOnlySchema.nullable(),
    status: ownerCopyStatusSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Не передано жодного поля для зміни')

export type UpdateCopyRequest = z.infer<typeof updateCopyRequestSchema>

// --- Відповіді ----------------------------------------------------------------

export const libraryResponseSchema = z.object({
  groups: z.array(libraryGroupSchema),
})

export type LibraryResponse = z.infer<typeof libraryResponseSchema>

export const borrowedLibraryResponseSchema = z.object({
  groups: z.array(borrowedLibraryGroupSchema),
})

export type BorrowedLibraryResponse = z.infer<typeof borrowedLibraryResponseSchema>

/** Бібліотека іншої людини — разом із тим, чия вона (§9: імʼя + аватар видно всім). */
export const visibleLibraryResponseSchema = z.object({
  owner: publicUserSchema,
  groups: z.array(visibleLibraryGroupSchema),
})

export type VisibleLibraryResponse = z.infer<typeof visibleLibraryResponseSchema>

export const copyResponseSchema = z.object({
  copy: ownCopySchema,
})

export type CopyResponse = z.infer<typeof copyResponseSchema>
