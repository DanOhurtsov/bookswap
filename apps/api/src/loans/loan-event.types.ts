import { z } from 'zod'
import type { LoanEventType } from '@bookswap/shared'

/**
 * Stage 10 (T4, §6.8): strict-схеми `LoanEvent.payload` за типом події.
 *
 * Описані лише типи, які реально пише код кроку 10d. Решту (`RECORD_*`, `GUEST_LOAN_RECORDED`, …)
 * додадуть кроки, що їх використовують, — разом зі своєю схемою. У payload не буває alias, email,
 * id контакту чи вільного тексту: `z.strictObject({})` відхиляє будь-яке поле, тож витік не
 * проходить мовчки. Фактична дата події — колонка `effectiveAt`, а не payload.
 */
const emptyPayloadSchema = z.strictObject({})

export const LOAN_EVENT_PAYLOAD_SCHEMA = {
  LOAN_LOST: emptyPayloadSchema,
  RECOVERED: emptyPayloadSchema,
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
