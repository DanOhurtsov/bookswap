import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  LOAN_ACTIONS,
  createLoanRequestSchema,
  loanQueryRequestSchema,
  updateLoanRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import { CreateLoanDto, LoanQueryDto, UpdateLoanDto } from './loan.dto'

/** Той самий тест парності, що й для решти DTO (§11). */
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

describe('CreateLoanDto ↔ createLoanRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CreateLoanDto, createLoanRequestSchema, [
      { name: 'лише примірник', payload: { copyId: 'copy-1' }, valid: true },
      {
        name: 'усі поля',
        payload: { copyId: 'copy-1', message: 'дуже хочу', proposedDueAt: '2026-06-12' },
        valid: true,
      },
      { name: 'без примірника', payload: {}, valid: false },
      { name: 'порожній примірник', payload: { copyId: '   ' }, valid: false },
      {
        name: 'дата з часом',
        payload: { copyId: 'c-1', proposedDueAt: '2026-06-12T10:00:00Z' },
        valid: false,
      },
      {
        name: 'неіснуюча дата',
        payload: { copyId: 'c-1', proposedDueAt: '2026-02-30' },
        valid: false,
      },
      {
        name: 'задовге повідомлення',
        payload: { copyId: 'c-1', message: 'я'.repeat(1001) },
        valid: false,
      },
    ])
  })

  it('не має поля «кількість»: позичається один примірник (§3)', () => {
    expect(createLoanRequestSchema.parse({ copyId: 'c-1', quantity: 2 })).not.toHaveProperty(
      'quantity',
    )
  })
})

describe('UpdateLoanDto ↔ updateLoanRequestSchema', () => {
  it('однаково приймає всі дії §8 і recover Етапу 10', () => {
    expectAgreement(
      UpdateLoanDto,
      updateLoanRequestSchema,
      // `amend_record` без дат — правило про пару полів (контролер і zod-refine); нижче окремо.
      LOAN_ACTIONS.filter((action) => action !== 'amend_record').map((action) => ({
        name: action,
        payload: { action },
        valid: true,
      })),
    )
  })

  it('amend_record: дати передачі й строку — рядки-дати; зіпсована дата відхиляється', () => {
    expectAgreement(UpdateLoanDto, updateLoanRequestSchema, [
      {
        name: 'нова дата передачі',
        payload: { action: 'amend_record', handedAt: '2026-05-01' },
        valid: true,
      },
      {
        name: 'новий строк',
        payload: { action: 'amend_record', dueAt: '2026-06-01' },
        valid: true,
      },
      {
        name: 'обидві дати',
        payload: { action: 'amend_record', handedAt: '2026-05-01', dueAt: '2026-06-01' },
        valid: true,
      },
      {
        name: 'зіпсована дата',
        payload: { action: 'amend_record', handedAt: 'вчора' },
        valid: false,
      },
      {
        name: 'dueAt: null — прибрати строк',
        payload: { action: 'amend_record', dueAt: null },
        valid: true,
      },
      {
        name: 'зіпсований строк',
        payload: { action: 'amend_record', dueAt: 'колись' },
        valid: false,
      },
      {
        name: 'порожній рядок замість строку',
        payload: { action: 'amend_record', dueAt: '' },
        valid: false,
      },
    ])
  })

  it('однаково відхиляє невідомі дії', () => {
    expectAgreement(UpdateLoanDto, updateLoanRequestSchema, [
      { name: 'без дії', payload: {}, valid: false },
      { name: 'невідома дія', payload: { action: 'destroy' }, valid: false },
      { name: 'дія іншим регістром', payload: { action: 'APPROVE' }, valid: false },
      { name: 'статус замість дії', payload: { action: 'APPROVED' }, valid: false },
    ])
  })

  it('приймає нотатку й термін на апруві', () => {
    expectAgreement(UpdateLoanDto, updateLoanRequestSchema, [
      {
        name: 'апрув із терміном',
        payload: { action: 'approve', dueAt: '2026-06-12' },
        valid: true,
      },
      {
        name: 'відмова з нотаткою',
        payload: { action: 'reject', note: 'вже обіцяв' },
        valid: true,
      },
      { name: 'зіпсована дата', payload: { action: 'approve', dueAt: 'колись' }, valid: false },
    ])
  })

  it('recover: дата знахідки — день без часу; невалідна відхиляється обома', () => {
    expectAgreement(UpdateLoanDto, updateLoanRequestSchema, [
      { name: 'без дати', payload: { action: 'recover' }, valid: true },
      { name: 'з датою', payload: { action: 'recover', effectiveAt: '2026-09-20' }, valid: true },
      {
        name: 'дата з часом',
        payload: { action: 'recover', effectiveAt: '2026-09-20T10:00Z' },
        valid: false,
      },
      {
        name: 'неіснуюча дата',
        payload: { action: 'recover', effectiveAt: '2026-02-30' },
        valid: false,
      },
      { name: 'не дата', payload: { action: 'recover', effectiveAt: 'вчора' }, valid: false },
    ])
  })

  it('розбіжність механізмів: «effectiveAt лише з recover» і «recover без note» — лише zod', () => {
    // Як і `dueAt`: пари полів `class-validator` не виражає, їх тримають zod і контролер.
    for (const payload of [
      { action: 'return', effectiveAt: '2026-09-20' },
      { action: 'recover', note: 'знайшли' },
    ]) {
      expect(updateLoanRequestSchema.safeParse(payload).success).toBe(false)
      expect(acceptedByDto(UpdateLoanDto, payload)).toBe(true)
    }
  })

  it('розбіжність механізмів: «dueAt лише з approve» виражає лише zod', () => {
    // `class-validator` не має способу сказати «поле дозволене залежно від
    // значення іншого поля», тож правило живе в zod для фронту й у контролері для
    // бекенду. Розбіжність зафіксована тестом, щоб лишалася явною, — так само, як
    // «оновити хоч щось» у `PATCH /me`.
    const payload = { action: 'return', dueAt: '2026-06-12' }

    expect(updateLoanRequestSchema.safeParse(payload).success).toBe(false)
    expect(acceptedByDto(UpdateLoanDto, payload)).toBe(true)
  })
})

describe('LoanQueryDto ↔ loanQueryRequestSchema', () => {
  it('однаково приймає й відхиляє фільтри §8', () => {
    expectAgreement(LoanQueryDto, loanQueryRequestSchema, [
      { name: 'без фільтрів', payload: {}, valid: true },
      { name: 'роль власника', payload: { role: 'owner' }, valid: true },
      { name: 'роль позичальника', payload: { role: 'borrower' }, valid: true },
      { name: 'статус', payload: { status: 'HANDED_OVER' }, valid: true },
      { name: 'обидва фільтри', payload: { role: 'owner', status: 'REQUESTED' }, valid: true },
      { name: 'невідома роль', payload: { role: 'admin' }, valid: false },
      { name: 'невідомий статус', payload: { status: 'OVERDUE' }, valid: false },
    ])
  })

  it('OVERDUE не є статусом (§5.2)', () => {
    // Прострочення — похідний прапорець; фільтрувати за ним як за статусом
    // означало б завести його в модель через чорний хід.
    expect(loanQueryRequestSchema.safeParse({ status: 'OVERDUE' }).success).toBe(false)
  })
})
