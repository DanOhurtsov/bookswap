import {
  answerGuestResponseRequestSchema,
  requestGuestCodeRequestSchema,
  resolveGuestResponseResponseSchema,
  verifyGuestCodeRequestSchema,
} from './guest-loan-response'

/** Stage 10, 10i.2: публічні контракти гостя. Лише синтетичні дані (D2). */

const base = { token: 'tok', nickname: '  Гість ', email: 'Guest@Guest.Invalid' }

describe('публічні контракти гостя (10i.2)', () => {
  it('код: нікнейм і адреса нормалізуються, реальний домен відхиляється (D2)', () => {
    expect(requestGuestCodeRequestSchema.parse(base)).toEqual({
      token: 'tok',
      nickname: 'Гість',
      email: 'guest@guest.invalid',
    })
    expect(
      requestGuestCodeRequestSchema.safeParse({ ...base, email: 'a@example.com' }).success,
    ).toBe(false)
  })

  it('нікнейм: порожній і задовгий відхиляються; зайві поля — теж', () => {
    expect(requestGuestCodeRequestSchema.safeParse({ ...base, nickname: '   ' }).success).toBe(
      false,
    )
    expect(
      requestGuestCodeRequestSchema.safeParse({ ...base, nickname: 'x'.repeat(61) }).success,
    ).toBe(false)
    expect(requestGuestCodeRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
  })

  it('verify: код рівно з шести цифр', () => {
    expect(verifyGuestCodeRequestSchema.safeParse({ ...base, code: '012345' }).success).toBe(true)

    for (const code of ['12345', '1234567', 'abcdef', '12 345', '']) {
      expect(verifyGuestCodeRequestSchema.safeParse({ ...base, code }).success).toBe(false)
    }
  })

  it('answer: лише RECEIVED/DENIED і обов’язковий доказ', () => {
    const answer = { ...base, proof: 'p', answer: 'RECEIVED' }

    expect(answerGuestResponseRequestSchema.safeParse(answer).success).toBe(true)
    expect(answerGuestResponseRequestSchema.safeParse({ ...answer, answer: 'MAYBE' }).success).toBe(
      false,
    )
    expect(
      answerGuestResponseRequestSchema.safeParse({ ...answer, proof: undefined }).success,
    ).toBe(false)
  })

  it('resolve-відповідь не має місця для email, alias чи історії', () => {
    const ok = {
      book: { title: 'Т', authors: [] },
      expiresAt: '2026-10-06T00:00:00.000Z',
    }

    expect(resolveGuestResponseResponseSchema.safeParse(ok).success).toBe(true)
    expect(resolveGuestResponseResponseSchema.safeParse({ ...ok, alias: 'x' }).success).toBe(false)
    // Рішення PO: handedAt до перевірки email не показується.
    expect(
      resolveGuestResponseResponseSchema.safeParse({ ...ok, handedAt: '2026-09-29T00:00:00.000Z' })
        .success,
    ).toBe(false)
  })
})
