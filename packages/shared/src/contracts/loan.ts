import { z } from 'zod'
import { conditionSchema, copyStatusSchema } from '../domain/copy'
import {
  loanActionSchema,
  loanOriginSchema,
  loanRoleSchema,
  loanStatusSchema,
  type LoanAction,
} from '../domain/loan'
import { editionSchema, workAuthorSchema, workSchema } from './catalog'
import { publicUserSchema } from './user'

/**
 * §5 і §8, блок «Позичання».
 *
 * Одна проєкція, а не три, як у бібліотеки, — і це не непослідовність. У лоану
 * рівно дві сторони, обидві його учасники, і жодна не бачить його «збоку»:
 * §6.6 обмежує **історію**, тобто погляд третьої людини. Ім'я контрагента тут
 * не приватність, а необхідність — без нього немає кому віддавати книжку.
 *
 * Приватне власника (`Copy.note`, `acquiredAt`, `visibility`) у лоан не
 * потрапляє: примірник представлений `loanCopySchema`, а не `ownCopySchema`.
 */

export const LOAN_LIMITS = {
  messageMax: 1000,
  noteMax: 1000,
  idMax: 64,
} as const

const idSchema = z.string().trim().min(1).max(LOAN_LIMITS.idMax)

const messageSchema = z.string().trim().max(LOAN_LIMITS.messageMax)

const noteSchema = z.string().trim().max(LOAN_LIMITS.noteMax)

/**
 * Термін повернення — саме дата, без часу, в обидва боки.
 *
 * Причина та сама, що в `acquiredAt` (`contracts/library.ts`): «о котрій годині
 * повернути» ніхто не домовляється. На бекенді день розгортається в кінець доби
 * UTC, щоб «до 12 червня» означало «включно з 12-м», а не «до півночі проти 12-го».
 */
const dueAtSchema = z.iso.date()

// --- Проєкції -----------------------------------------------------------------

/**
 * Примірник у контексті лоану.
 *
 * Свідомо вужчий за будь-яку проєкцію `contracts/library.ts`: домовленість про
 * конкретну книжку не дає доступу ні до нотаток власника, ні до його
 * налаштувань видимості.
 */
export const loanCopySchema = z.object({
  id: z.string(),
  status: copyStatusSchema,
  condition: conditionSchema,
  /** Stage 10 (10d): архівний примірник не можна відновити з `LOST` — спершу `restore`. */
  isArchived: z.boolean(),
})

export type LoanCopy = z.infer<typeof loanCopySchema>

/**
 * Stage 10 (10d, T4): факт знахідки втраченої книжки. Приватна подія `LoanEvent` — її бачать лише
 * сторони позики (цей API віддає тільки їх); друзям і стороннім вона не віддається ніде.
 * `Loan.status` при цьому лишається `LOST`: це історичний факт, а не поточний стан примірника.
 */
export const loanRecoverySchema = z.object({
  /** Фактична дата знахідки (за замовчуванням — момент запису). */
  effectiveAt: z.iso.datetime(),
  /** Коли знахідку записано в системі. */
  recordedAt: z.iso.datetime(),
})

export type LoanRecovery = z.infer<typeof loanRecoverySchema>

export const loanSchema = z.object({
  id: z.string(),
  status: loanStatusSchema,
  /**
   * §5.2: `OVERDUE` — не статус, а похідне `status = HANDED_OVER AND dueAt < now()`.
   * Рахує його сервер: інакше кожен клієнт відповідав би на це питання власним
   * годинником, і два пристрої показували б різне.
   */
  isOverdue: z.boolean(),
  message: z.string().nullable(),
  responseNote: z.string().nullable(),
  /**
   * Stage 10 (10e): для `origin = RECORDED_EXISTING` запиту не було — `null`, «Попросили» не вигадується.
   * Джерелом істини про наявність запиту є `origin`.
   */
  origin: loanOriginSchema.extract(['REQUESTED', 'RECORDED_EXISTING']),
  /** Stage 10 (10e): коли запис створено в системі (для записаної позики — момент запису, а не передачі). */
  createdAt: z.iso.datetime(),
  requestedAt: z.iso.datetime().nullable(),
  /** Коли власник відповів на запит. Лишається `null` для скасованих запитів. */
  respondedAt: z.iso.datetime().nullable(),
  handedAt: z.iso.datetime().nullable(),
  returnedAt: z.iso.datetime().nullable(),
  dueAt: dueAtSchema.nullable(),
  owner: publicUserSchema,
  borrower: publicUserSchema,
  copy: loanCopySchema,
  edition: editionSchema,
  work: workSchema,
  authors: z.array(workAuthorSchema),
  /** `null`, доки знахідку не зафіксовано (і завжди для не-`LOST` позик). */
  recovery: loanRecoverySchema.nullable(),
})

export type Loan = z.infer<typeof loanSchema>

// --- Запити -------------------------------------------------------------------

/** §8: `POST /loans { copyId, message, proposedDueAt }`. */
export const createLoanRequestSchema = z.object({
  copyId: idSchema,
  message: messageSchema.optional(),
  /**
   * Побажання позичальника, не домовленість: остаточний термін ставить власник
   * на апруві. Лягає в `Loan.dueAt` одразу, щоб власник бачив, про що його просять.
   */
  proposedDueAt: dueAtSchema.optional(),
})

export type CreateLoanRequest = z.infer<typeof createLoanRequestSchema>

/**
 * §8: `PATCH /loans/:id { action, note?, dueAt?, effectiveAt? }`.
 *
 * `dueAt` приймається **лише** разом із `action: 'approve'` — термін повернення
 * встановлює власник, погоджуючи запит. Правило про пару полів `class-validator`
 * не виражає, тож його перевіряє контролер (як і «хоч одне поле» в `PATCH /me`).
 *
 * `effectiveAt` (Stage 10, 10d) — фактична дата знахідки, лише з `action: 'recover'`. `note` з
 * `recover` не поєднується: `recover` не переписує жодного минулого факту позики, зокрема
 * `responseNote`. Що дата не в майбутньому, перевіряє сервер за своїм годинником.
 */
export const updateLoanRequestSchema = z
  .object({
    action: loanActionSchema,
    note: noteSchema.optional(),
    // `null` — лише для `amend_record` (Q23: прибрати строк); відсутнє поле — строк не змінюється.
    dueAt: dueAtSchema.nullable().optional(),
    effectiveAt: dueAtSchema.optional(),
    handedAt: dueAtSchema.optional(),
  })
  .refine(
    (value) =>
      value.dueAt === undefined || value.action === 'approve' || value.action === 'amend_record',
    'Термін повернення встановлюється під час підтвердження запиту або виправлення запису',
  )
  .refine(
    (value) => value.dueAt !== null || value.action === 'amend_record',
    'Прибрати строк повернення можна лише дією amend_record',
  )
  .refine(
    (value) => value.effectiveAt === undefined || value.action === 'recover',
    'Дату знахідки можна вказати лише разом із дією recover',
  )
  .refine(
    (value) => value.handedAt === undefined || value.action === 'amend_record',
    'Дату передачі можна вказати лише разом із дією amend_record',
  )
  .refine(
    (value) =>
      value.note === undefined || (value.action !== 'recover' && !isRecordAction(value.action)),
    'Примітка не поєднується з цією дією',
  )
  .refine(
    (value) =>
      value.action !== 'amend_record' || value.handedAt !== undefined || value.dueAt !== undefined,
    'Для amend_record потрібна нова дата передачі або строк повернення',
  )

export type UpdateLoanRequest = z.infer<typeof updateLoanRequestSchema>

export function isRecordAction(action: LoanAction): boolean {
  return (
    action === 'confirm_record' ||
    action === 'decline_record' ||
    action === 'withdraw_record' ||
    action === 'amend_record'
  )
}

/**
 * Stage 10 (10e, D6): `POST /loans/recorded` — власник записує вже передану книжку.
 *
 * `handedAt` — фактична дата передачі (день, не в майбутньому — це перевіряє сервер за своєю датою UTC);
 * `dueAt` — необов'язковий строк повернення, не раніше дня передачі. `message` немає: вільного тексту запис
 * не несе.
 */
export const createRecordedLoanRequestSchema = z
  .object({
    copyId: idSchema,
    borrowerId: idSchema,
    handedAt: dueAtSchema,
    dueAt: dueAtSchema.optional(),
  })
  .refine(
    (value) => value.dueAt === undefined || value.dueAt >= value.handedAt,
    'Строк повернення не може бути раніше дати передачі',
  )

export type CreateRecordedLoanRequest = z.infer<typeof createRecordedLoanRequestSchema>

/** §8: `GET /loans?role=owner|borrower&status=…`. Обидва фільтри незалежні. */
export const loanQueryRequestSchema = z.object({
  role: loanRoleSchema.optional(),
  status: loanStatusSchema.optional(),
})

export type LoanQueryRequest = z.infer<typeof loanQueryRequestSchema>

// --- Відповіді ----------------------------------------------------------------

export const loanResponseSchema = z.object({ loan: loanSchema })

export type LoanResponse = z.infer<typeof loanResponseSchema>

export const loanListResponseSchema = z.object({ loans: z.array(loanSchema) })

export type LoanListResponse = z.infer<typeof loanListResponseSchema>
