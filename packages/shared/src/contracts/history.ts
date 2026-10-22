import { z } from 'zod'
import { conditionSchema, copyStatusSchema } from '../domain/copy'
import { guestLoanEvidenceSchema, loanOriginSchema, loanStatusSchema } from '../domain/loan'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { publicUserSchema } from './user'

/**
 * §6.6 і §8, блок «Історія».
 *
 * Історія виводиться з `Loan` — окремих таблиць немає (§4.6). Тому запис історії
 * це не нова сутність, а **проєкція лоану для того, хто дивиться збоку**.
 *
 * Проєкцій дві, і різниця між ними — не косметична. §6.6 каже: повну історію з
 * іменами власник бачить завжди, інші — за `User.showHolderNames`; якщо вимкнено,
 * показується статус без імен («у когось до 12 червня»). §9 при цьому вимагає,
 * щоб приватне **не віддавалося з API**, а не ховалося в UI. Єдиний надійний
 * спосіб це гарантувати — щоб полів з іменами у відповідній схемі не існувало
 * взагалі. Одна схема з `.nullable()` рано чи пізно віддала б ім'я не тому: досить
 * забути занулити одне вкладене поле.
 *
 * Тому анонімний запис не має ані `owner`/`borrower`, ані `loanId`. Останній
 * прибрано навмисно: дій над чужим лоаном немає (`GET /loans/:id` віддасть 404),
 * тож id був би рівно тим ідентифікатором, за яким можна корелювати два різні
 * зрізи історії між собою.
 */

const historyFactsSchema = z.object({
  status: loanStatusSchema,
  /** §5.2: похідне від `HANDED_OVER` і `dueAt`, а не окремий статус. */
  isOverdue: z.boolean(),
  /**
   * Stage 10 (10b): звідки взялася позика. Це не приватне поле — воно лише каже клієнтові, чи був
   * запит: `REQUESTED` — звичайний request-flow, інакше позику записав власник.
   */
  origin: loanOriginSchema,
  /**
   * Stage 10 (10i.1): джерело доказу гостьової передачі, виведене з рядка підтвердження — «зі слів
   * власника» / «очікується відповідь» / «підтверджено гостем» / «гість заперечує». `null` для
   * позик не-гостьового походження. Лише факт про джерело, без alias/нікнейма/email.
   */
  guestEvidence: guestLoanEvidenceSchema.nullable(),
  /**
   * Stage 10 (T2): `null` для записаних власником позик — запиту не було, і дата не вигадується.
   * Але БД має дефолт `now()`, тож ненульове значення при `origin ≠ REQUESTED` не означає запиту:
   * джерелом істини є `origin`, а не `requestedAt`.
   */
  requestedAt: z.iso.datetime().nullable(),
  respondedAt: z.iso.datetime().nullable(),
  handedAt: z.iso.datetime().nullable(),
  returnedAt: z.iso.datetime().nullable(),
  dueAt: z.iso.date().nullable(),
})

/** §6.6: імена дозволені — власнику завжди, другові за `showHolderNames`. */
export const namedHistoryEntrySchema = historyFactsSchema.extend({
  names: z.literal(true),
  loanId: z.string(),
  owner: publicUserSchema,
  borrower: publicUserSchema,
})

export type NamedHistoryEntry = z.infer<typeof namedHistoryEntrySchema>

/** §6.6: «у когось до 12 червня» — самі факти, жодного носія особи. */
export const anonymousHistoryEntrySchema = historyFactsSchema.extend({
  names: z.literal(false),
})

export type AnonymousHistoryEntry = z.infer<typeof anonymousHistoryEntrySchema>

/**
 * Дискримінований union, а не два різні поля відповіді: клієнт звужує тип одним
 * `entry.names === true` і фізично не може прочитати ім'я там, де його немає.
 */
export const historyEntrySchema = z.discriminatedUnion('names', [
  namedHistoryEntrySchema,
  anonymousHistoryEntrySchema,
])

export type HistoryEntry = z.infer<typeof historyEntrySchema>

/**
 * Примірник у контексті історії.
 *
 * Не несе ані `ownerId`, ані `currentHolderId`, ані вкладеного власника — і це
 * та сама вимога §6.6, застосована до обгортки. Чия це полиця, викликач знає зі
 * сторінки, з якої прийшов; колонка з id у тілі відповіді була б каналом витоку
 * рівно тоді, коли імена приховані.
 */
export const historyCopySchema = z.object({
  id: z.string(),
  status: copyStatusSchema,
  condition: conditionSchema,
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
})

export type HistoryCopy = z.infer<typeof historyCopySchema>

/** §8: `GET /copies/:id/history` — усі лоани конкретного примірника в хронології. */
export const copyHistoryResponseSchema = z.object({
  copy: historyCopySchema,
  entries: z.array(historyEntrySchema),
})

export type CopyHistoryResponse = z.infer<typeof copyHistoryResponseSchema>

/**
 * §6.6: «хто з моїх це взагалі читав» — практично корисніше за історію примірника,
 * бо саме це людина хоче знати перед тим, як просити.
 *
 * Запис несе ще й видання: у твору їх кілька, і «читав» без уточнення, який саме
 * том, відповідає не на те питання (§3).
 */
export const workHistoryEntrySchema = z.object({
  entry: historyEntrySchema,
  copyId: z.string(),
  edition: editionSchema,
})

export type WorkHistoryEntry = z.infer<typeof workHistoryEntrySchema>

export const workHistoryResponseSchema = z.object({
  work: workSchema,
  authors: z.array(workAuthorSchema),
  entries: z.array(workHistoryEntrySchema),
})

export type WorkHistoryResponse = z.infer<typeof workHistoryResponseSchema>

/**
 * §8: `GET /me/history` — «що я брав і що в мене брали». The two directions stay separate arrays;
 * the web merges them into one list (BS-142).
 *
 * `borrowed` завжди іменований: viewer сам бере участь як зареєстрований позичальник, а гість
 * ніколи не може бути «я». `lent` (Stage 10, 10f.3) може містити й анонімний гостьовий факт
 * (`names: false`, без alias/contactId/loanId) — саме тому тут `historyEntrySchema` (union), а не
 * `namedHistoryEntrySchema`: власник бачить, що комусь передавав книжку, але не хто саме — alias
 * віддається лише через окремий owner-only `GET /loans/guest[/:id]` (D4, P1/P2).
 */
export const myHistoryEntrySchema = z.object({
  entry: historyEntrySchema,
  copy: historyCopySchema,
  /**
   * BS-142: when the loan reliably ended, derived from facts already stored — the stamp or the
   * `LoanEvent` of the closing transition (docs/plan/bs-142-unified-loan-history.md). `null` both
   * for an open loan and for a closed one whose ending was never recorded (e.g. a cancelled request
   * or a `LOST` loan from before Stage 10): never substituted with the request date, `dueAt` or now.
   * Only in the personal history — copy and work histories do not carry it.
   */
  completedAt: z.iso.datetime().nullable(),
  /**
   * BS-142: the latest reliably dated fact of the loan — the stored dates shown in the entry (the
   * request only for `origin = REQUESTED`), the ending, and a recovery after a loss (`RECOVERED`,
   * its actual date). Orders the loans whose `completedAt` is unknown; it is never their ending.
   * Derived on the server: no event, payload or actor is sent. `null` only when no fact is dated.
   */
  latestFactAt: z.iso.datetime().nullable(),
})

export type MyHistoryEntry = z.infer<typeof myHistoryEntrySchema>

export const myHistoryResponseSchema = z.object({
  borrowed: z.array(myHistoryEntrySchema),
  lent: z.array(myHistoryEntrySchema),
})

export type MyHistoryResponse = z.infer<typeof myHistoryResponseSchema>
