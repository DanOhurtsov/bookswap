import { z } from 'zod'
import type { LoanEventType } from '@bookswap/shared'

/**
 * Stage 10 (T4, §6.8): strict-схеми `LoanEvent.payload` за типом події.
 *
 * Описані типи, які реально пишуть кроки 10d–10f.3 (`LOAN_LOST`, `RECOVERED`, `LOAN_RETURNED` для
 * записаних позик, `RECORD_*`, і, з 10f.3, `GUEST_LOAN_RECORDED`/`LOSS_CLOSED`). У payload не буває
 * alias, email, id контакту чи вільного тексту: `z.strictObject({})` відхиляє будь-яке поле, тож витік
 * не проходить мовчки. Фактична дата події — колонка `effectiveAt`, а не payload.
 */
const emptyPayloadSchema = z.strictObject({})

/** Stage 10 (10e): дати запису — день без часу. Не PII, не вільний текст; `dueOn = null` — строку немає. */
const recordDatesSchema = z.strictObject({
  handedOn: z.iso.date(),
  dueOn: z.iso.date().nullable(),
})

export type RecordDates = z.infer<typeof recordDatesSchema>

export const LOAN_EVENT_PAYLOAD_SCHEMA = {
  LOAN_LOST: emptyPayloadSchema,
  RECOVERED: emptyPayloadSchema,
  LOAN_RETURNED: emptyPayloadSchema,
  RECORD_PROPOSED: recordDatesSchema,
  RECORD_AMENDED: z.strictObject({ previous: recordDatesSchema, next: recordDatesSchema }),
  RECORD_CONFIRMED: emptyPayloadSchema,
  RECORD_DECLINED: emptyPayloadSchema,
  RECORD_WITHDRAWN: emptyPayloadSchema,
  // Stage 10 (10f.3): створення й закриття втрати гостьової позики — жодного alias/contactId у payload.
  GUEST_LOAN_RECORDED: emptyPayloadSchema,
  LOSS_CLOSED: emptyPayloadSchema,
  // Stage 10 (10i.1): запит підтвердження, скасування помилкової передачі, запис лише зі слів власника —
  // жодного alias/нікнейма/email/id контакту в payload. Події відповіді гостя додасть 10i.2.
  GUEST_CONFIRMATION_REQUESTED: emptyPayloadSchema,
  GUEST_HANDOVER_CANCELLED: emptyPayloadSchema,
  GUEST_LOAN_OWNER_RECORDED: emptyPayloadSchema,
  // Stage 10 (10i.2): відповідь гостя — `actorId = null`, payload порожній: ні нікнейма, ні email, ні id контакту.
  GUEST_LOAN_RECEIVED: emptyPayloadSchema,
  GUEST_LOAN_DENIED: emptyPayloadSchema,
} as const satisfies Partial<Record<LoanEventType, z.ZodTypeAny>>

export type WritableLoanEventType = keyof typeof LOAN_EVENT_PAYLOAD_SCHEMA

export function isWritableLoanEventType(type: LoanEventType): type is WritableLoanEventType {
  return type in LOAN_EVENT_PAYLOAD_SCHEMA
}

export interface NewLoanEvent {
  loanId: string
  type: WritableLoanEventType
  /** Хто зробив дію; `null` — система. */
  actorId: string | null
  /** Фактична дата, якщо відрізняється від моменту запису (напр. дата знахідки). */
  effectiveAt?: Date
  payload?: unknown
}
