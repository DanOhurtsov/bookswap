import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { createGuestLoanRequestSchema, updateGuestLoanRequestSchema } from '@bookswap/shared'
import type { ZodType } from 'zod'
import { CreateGuestLoanDto, UpdateGuestLoanDto } from './guest-loan.dto'

type Constructor<T> = new () => T

function acceptedByDto<T extends object>(Dto: Constructor<T>, payload: unknown): boolean {
  const instance = plainToInstance(Dto, payload)

  return (
    validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true }).length === 0
  )
}

function expectAgreement<T extends object>(
  Dto: Constructor<T>,
  schema: ZodType,
  cases: { name: string; payload: unknown; valid: boolean }[],
): void {
  for (const { name, payload, valid } of cases) {
    const byZod = schema.safeParse(payload).success
    const byDto = acceptedByDto(Dto, payload)

    expect({ name, byZod, byDto }).toEqual({ name, byZod: valid, byDto: valid })
  }
}

describe('CreateGuestLoanDto ↔ createGuestLoanRequestSchema', () => {
  const base = { copyId: 'copy-1', externalBorrowerId: 'contact-1', handedAt: '2026-01-01' }

  it('однаково приймає й відхиляє однакові дані, включно з dueAt null/omitted/валідним', () => {
    expectAgreement(CreateGuestLoanDto, createGuestLoanRequestSchema, [
      { name: 'без dueAt (omitted)', payload: base, valid: true },
      { name: 'dueAt валідний', payload: { ...base, dueAt: '2026-02-01' }, valid: true },
      // Item 2 (рев'ю): `null` — НЕ те саме, що «не передали». Обидва боки мають відхиляти його
      // однаково, а не мовчки пропускати до `Invalid Date`.
      { name: 'dueAt null', payload: { ...base, dueAt: null }, valid: false },
      { name: 'dueAt не ISO-дата', payload: { ...base, dueAt: 'учора' }, valid: false },
      { name: 'без handedAt', payload: { copyId: 'c', externalBorrowerId: 'e' }, valid: false },
      { name: 'handedAt null', payload: { ...base, handedAt: null }, valid: false },
      { name: 'порожній copyId', payload: { ...base, copyId: '' }, valid: false },
      {
        name: 'borrowerId (не існує для гостя)',
        payload: { ...base, borrowerId: 'u-1' },
        valid: false,
      },
      { name: 'message (заборонено, D1)', payload: { ...base, message: 'вітаю' }, valid: false },
      { name: 'note (заборонено, D1)', payload: { ...base, note: 'x' }, valid: false },
    ])
  })

  /**
   * Навмисна асиметрія, а не прогалина: правило `dueAt ≥ handedAt` — це zod-`refine`
   * (`createGuestLoanRequestSchema`), яке DTO не виражає, той самий розподіл праці, що вже є для
   * реєстрованого `CreateRecordedLoanDto`/`createRecordedLoanRequestSchema` (порівняй
   * `assertRecordDates` у `loan.service.ts`). За кордоном DTO цю дату перевіряє сервіс
   * (`assertGuestLoanDates` → `400 LOAN_RECORD_DATE_INVALID`, конкретніший код, ніж загальний
   * `VALIDATION_ERROR`), тож `expectAgreement` тут навмисно не застосовується.
   */
  it('dueAt раніше handedAt: DTO пропускає (перевіряє сервіс), zod-схема відхиляє — асиметрія навмисна', () => {
    const payload = { ...base, dueAt: '2025-12-01' }

    expect(createGuestLoanRequestSchema.safeParse(payload).success).toBe(false)
    expect(acceptedByDto(CreateGuestLoanDto, payload)).toBe(true)
  })
})

describe('UpdateGuestLoanDto ↔ updateGuestLoanRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані, включно з effectiveAt null/omitted/валідним', () => {
    expectAgreement(UpdateGuestLoanDto, updateGuestLoanRequestSchema, [
      { name: 'return без effectiveAt', payload: { action: 'return' }, valid: true },
      { name: 'mark_lost без effectiveAt', payload: { action: 'mark_lost' }, valid: true },
      { name: 'close_loss без effectiveAt', payload: { action: 'close_loss' }, valid: true },
      {
        name: 'recover з валідним effectiveAt',
        payload: { action: 'recover', effectiveAt: '2026-01-01' },
        valid: true,
      },
      { name: 'recover без effectiveAt', payload: { action: 'recover' }, valid: true },
      // Item 2 (рев'ю): те саме правило null ≠ omitted, для effectiveAt.
      {
        name: 'recover з effectiveAt null',
        payload: { action: 'recover', effectiveAt: null },
        valid: false,
      },
      { name: 'невідома дія', payload: { action: 'approve' }, valid: false },
      { name: 'дія запису (заборонено)', payload: { action: 'confirm_record' }, valid: false },
      { name: 'без action', payload: { effectiveAt: '2026-01-01' }, valid: false },
      { name: 'note (заборонено, D1)', payload: { action: 'return', note: 'x' }, valid: false },
    ])
  })

  /**
   * Навмисна асиметрія: «`effectiveAt` лише з `recover`» — правило пари полів, яке (як і в
   * реєстрованому `UpdateLoanDto`/`LoansController.update`) перевіряє КОНТРОЛЕР
   * (`GuestLoansController.update`), а не сам DTO — `class-validator` не виражає «поле дозволене
   * лише разом із конкретним значенням іншого поля» без `@ValidateIf` на кожному полі окремо, і
   * контролер уже робить це для реєстрованого флоу тим самим прийомом.
   */
  it('close_loss з effectiveAt: DTO пропускає (перевіряє контролер), zod-схема відхиляє — асиметрія навмисна', () => {
    const payload = { action: 'close_loss', effectiveAt: '2026-01-01' }

    expect(updateGuestLoanRequestSchema.safeParse(payload).success).toBe(false)
    expect(acceptedByDto(UpdateGuestLoanDto, payload)).toBe(true)
  })
})
