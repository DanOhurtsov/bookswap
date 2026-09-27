import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  createExternalBorrowerRequestSchema,
  updateExternalBorrowerRequestSchema,
} from '@bookswap/shared'
import type { ZodType } from 'zod'
import { CreateExternalBorrowerDto, UpdateExternalBorrowerDto } from './external-borrower.dto'

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

describe('CreateExternalBorrowerDto ↔ createExternalBorrowerRequestSchema', () => {
  it('однаково приймає й відхиляє однакові дані', () => {
    expectAgreement(CreateExternalBorrowerDto, createExternalBorrowerRequestSchema, [
      { name: 'валідні', payload: { alias: 'Тестовий Гість', ownerInformed: true }, valid: true },
      {
        name: 'alias із пробілами',
        payload: { alias: '  Гість  ', ownerInformed: true },
        valid: true,
      },
      { name: 'порожній alias', payload: { alias: '', ownerInformed: true }, valid: false },
      { name: 'alias із пробілів', payload: { alias: '   ', ownerInformed: true }, valid: false },
      {
        name: 'задовгий alias',
        payload: { alias: 'x'.repeat(81), ownerInformed: true },
        valid: false,
      },
      { name: 'без alias', payload: { ownerInformed: true }, valid: false },
      {
        name: 'ownerInformed=false',
        payload: { alias: 'Гість', ownerInformed: false },
        valid: false,
      },
      { name: 'без ownerInformed', payload: { alias: 'Гість' }, valid: false },
      {
        name: 'ownerInformed рядком',
        payload: { alias: 'Гість', ownerInformed: 'true' },
        valid: false,
      },
      { name: 'ownerId', payload: { alias: 'Г', ownerInformed: true, ownerId: 'u' }, valid: false },
      {
        name: 'ownerInformedAt',
        payload: { alias: 'Г', ownerInformed: true, ownerInformedAt: '2026-01-01T00:00:00.000Z' },
        valid: false,
      },
      {
        name: 'retainUntil',
        payload: { alias: 'Г', ownerInformed: true, retainUntil: null },
        valid: false,
      },
      { name: 'email', payload: { alias: 'Г', ownerInformed: true, email: 'a@b.c' }, valid: false },
      { name: 'note', payload: { alias: 'Г', ownerInformed: true, note: 'x' }, valid: false },
    ])
  })
})

describe('UpdateExternalBorrowerDto ↔ updateExternalBorrowerRequestSchema', () => {
  it('змінює лише alias', () => {
    expectAgreement(UpdateExternalBorrowerDto, updateExternalBorrowerRequestSchema, [
      { name: 'валідний', payload: { alias: 'Нове' }, valid: true },
      { name: 'порожній', payload: { alias: ' ' }, valid: false },
      { name: 'без полів', payload: {}, valid: false },
      { name: 'ownerInformed', payload: { alias: 'Н', ownerInformed: true }, valid: false },
      { name: 'ownerInformedAt', payload: { alias: 'Н', ownerInformedAt: 'x' }, valid: false },
      { name: 'retainUntil', payload: { alias: 'Н', retainUntil: null }, valid: false },
      { name: 'ownerId', payload: { alias: 'Н', ownerId: 'u' }, valid: false },
    ])
  })
})
