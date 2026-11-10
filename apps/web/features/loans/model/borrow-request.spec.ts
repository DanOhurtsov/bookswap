import { API_ERROR_CODES, type ApiErrorCode } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { borrowOutcomeOf, isClosedPhase, phaseOfFailure, sendFailureText } from './borrow-request'

const conflict = (code: ApiErrorCode) => new ApiRequestError(409, { code, message: 'Конфлікт' })

describe('phaseOfFailure', () => {
  it('a 409 is told by its code', () => {
    expect(phaseOfFailure(conflict(API_ERROR_CODES.LOAN_DUPLICATE_REQUEST))).toEqual({
      kind: 'duplicate',
    })
    expect(phaseOfFailure(conflict(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE))).toEqual({
      kind: 'unavailable',
    })
    expect(phaseOfFailure(conflict(API_ERROR_CODES.LOAN_REQUESTS_PAUSED))).toEqual({
      kind: 'paused',
    })
  })

  it('anything else is a failure to retry', () => {
    const lost = new TypeError('Failed to fetch')
    const other = conflict(API_ERROR_CODES.LOAN_INVALID_TRANSITION)

    expect(phaseOfFailure(lost)).toEqual({ kind: 'failed', failure: lost })
    expect(phaseOfFailure(other)).toEqual({ kind: 'failed', failure: other })
  })
})

describe('isClosedPhase', () => {
  it('a settled request closes the form; a draft, a send or a failure keep it', () => {
    expect(isClosedPhase({ kind: 'sent', loanId: 'l' })).toBe(true)
    expect(isClosedPhase({ kind: 'duplicate' })).toBe(true)
    expect(isClosedPhase({ kind: 'unavailable' })).toBe(true)
    expect(isClosedPhase({ kind: 'paused' })).toBe(true)
    expect(isClosedPhase({ kind: 'draft' })).toBe(false)
    expect(isClosedPhase({ kind: 'sending' })).toBe(false)
    expect(isClosedPhase({ kind: 'failed', failure: null })).toBe(false)
  })
})

describe('borrowOutcomeOf', () => {
  const base = { ownerName: 'Марта', myLoanId: null, expectedReturnAt: null }

  it('sent: opens the created request', () => {
    expect(borrowOutcomeOf({ ...base, phase: { kind: 'sent', loanId: 'loan-1' } })).toEqual({
      tone: 'ok',
      title: 'Запит надіслано',
      text: 'Марта отримає сповіщення і зможе погодити запит, змінивши дату, або відмовити. Про відповідь вам прийде сповіщення.',
      loanId: 'loan-1',
    })
  })

  it('duplicate: opens the request the shelf knows, if it knows one', () => {
    expect(borrowOutcomeOf({ ...base, phase: { kind: 'duplicate' } }).loanId).toBeNull()
    expect(
      borrowOutcomeOf({ ...base, myLoanId: 'loan-2', phase: { kind: 'duplicate' } }),
    ).toMatchObject({ tone: 'info', title: 'Запит уже надіслано', loanId: 'loan-2' })
  })

  it('unavailable: «орієнтовно вільна» only when the owner set it', () => {
    expect(borrowOutcomeOf({ ...base, phase: { kind: 'unavailable' } }).text).toBe(
      'Поки ви заповнювали запит, примірник став недоступним.',
    )
    expect(
      borrowOutcomeOf({ ...base, expectedReturnAt: '2026-12-01', phase: { kind: 'unavailable' } }),
    ).toEqual({
      tone: 'warn',
      title: 'Книжку зараз не можна попросити',
      text: 'Поки ви заповнювали запит, примірник став недоступним. Орієнтовно вільна з 01.12.26.',
      loanId: null,
    })
  })

  it('paused: nothing to open', () => {
    expect(borrowOutcomeOf({ ...base, phase: { kind: 'paused' } })).toEqual({
      tone: 'warn',
      title: 'Власник зараз не приймає запитів',
      text: 'Марта тимчасово не приймає запитів на позичання. Спробуйте пізніше.',
      loanId: null,
    })
  })
})

describe('sendFailureText', () => {
  it('a refusal tells the server’s reason; anything else, the connection', () => {
    expect(
      sendFailureText(
        new ApiRequestError(400, { code: 'VALIDATION_ERROR', message: 'Погана дата.' }),
      ),
    ).toBe('Не вдалося надіслати запит. Погана дата. Дата й повідомлення збережені.')
    expect(sendFailureText(new TypeError('Failed to fetch'))).toBe(
      'Не вдалося надіслати запит. Перевірте зʼєднання і спробуйте ще раз. Дата й повідомлення збережені.',
    )
  })
})
