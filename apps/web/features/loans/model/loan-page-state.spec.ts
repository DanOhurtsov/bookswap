import { loanOf } from '../loans.test-helpers'
import {
  LOAD_PROBLEM_WORDS,
  loadProblemOf,
  loanPageStateOf,
  type LoanPageMemory,
} from './loan-page-state'

const LOAN = loanOf({ id: 'loan-7', side: 'lent' })
const FRESH = { ...LOAN, status: 'RETURNED' as const }
const LOADING = { status: 'loading' } as const
const remembered = (memory: Partial<LoanPageMemory>): LoanPageMemory => ({
  loanId: 'loan-7',
  loan: undefined,
  problem: undefined,
  ...memory,
})
const failed = (httpStatus?: number) => ({
  status: 'error' as const,
  message: 'Request failed with status 500',
  ...(httpStatus === undefined ? {} : { httpStatus }),
})

describe('чому позику не показано — лише за HTTP-статусом (BS-153)', () => {
  it.each([
    [403, 'gone'],
    [404, 'gone'],
    [400, 'gone'],
    [410, 'gone'],
    [401, 'signed-out'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [408, 'unavailable'],
    [429, 'unavailable'],
    [409, 'failed'],
    [422, 'failed'],
  ])('%i → %s', (status, problem) => {
    expect(loadProblemOf(status)).toBe(problem)
  })

  it('немає статусу (мережа) — тимчасова недоступність, а не 404', () => {
    expect(loadProblemOf(undefined)).toBe('unavailable')
  })

  it('403 і 404 кажуть однаково: чужу позику не відрізнити від неіснуючої', () => {
    expect(LOAD_PROBLEM_WORDS[loadProblemOf(403)]).toBe(LOAD_PROBLEM_WORDS[loadProblemOf(404)])
  })
})

describe('що показує сторінка позики, поки її дані перечитуються', () => {
  it('перше завантаження — скелет', () => {
    expect(loanPageStateOf(LOADING, undefined, 'loan-7', false)).toEqual({ status: 'loading' })
  })

  it('нова відповідь — свіжа позика', () => {
    expect(
      loanPageStateOf(
        { status: 'ready', data: { loan: FRESH } },
        remembered({ loan: LOAN }),
        'loan-7',
        false,
      ),
    ).toEqual({ status: 'ready', loan: FRESH, refreshProblem: null })
  })

  it('перечитування після дії не повертає скелет: лишається показана позика', () => {
    expect(loanPageStateOf(LOADING, remembered({ loan: LOAN }), 'loan-7', false)).toEqual({
      status: 'ready',
      loan: LOAN,
      refreshProblem: null,
    })
  })

  it.each([undefined, 500, 503])(
    'тимчасова невдача (%s) перечитування — над позикою, а не замість неї',
    (status) => {
      expect(loanPageStateOf(failed(status), remembered({ loan: LOAN }), 'loan-7', false)).toEqual({
        status: 'ready',
        loan: LOAN,
        refreshProblem: 'unavailable',
      })
    },
  )

  it.each([
    [401, 'signed-out'],
    [403, 'gone'],
    [404, 'gone'],
    [409, 'failed'],
  ] as const)('після %i стара позика більше не показується', (status, problem) => {
    expect(loanPageStateOf(failed(status), remembered({ loan: LOAN }), 'loan-7', false)).toEqual({
      status: 'error',
      problem,
      retrying: false,
    })
  })

  it('позика іншого loanId не показується замість потрібної', () => {
    expect(
      loanPageStateOf(LOADING, remembered({ loanId: 'loan-1', loan: LOAN }), 'loan-7', false),
    ).toEqual({ status: 'loading' })
    expect(
      loanPageStateOf(failed(500), remembered({ loanId: 'loan-1', loan: LOAN }), 'loan-7', false),
    ).toEqual({ status: 'error', problem: 'unavailable', retrying: false })
  })

  it('без позики — проблема на всю сторінку; під час повтору — та сама, з повтором у роботі', () => {
    expect(loanPageStateOf(failed(503), undefined, 'loan-7', false)).toEqual({
      status: 'error',
      problem: 'unavailable',
      retrying: false,
    })
    expect(
      loanPageStateOf(LOADING, remembered({ problem: 'unavailable' }), 'loan-7', true),
    ).toEqual({ status: 'error', problem: 'unavailable', retrying: true })
  })
})
