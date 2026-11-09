import { formatDate } from '@/app/lib/labels'
import { loanOf } from '../loans.test-helpers'
import { loanTimelineOf } from './loan-timeline'

type Facts = Omit<Parameters<typeof loanOf>[0], 'id' | 'side'>

const timeline = (facts: Facts) => loanTimelineOf(loanOf({ id: 'l', side: 'lent', ...facts }))
const titles = (facts: Facts) => timeline(facts).map(({ tone, title }) => `${tone}: ${title}`)

const REQUESTED_AT = '2026-10-01T09:00:00.000Z'
const RESPONDED_AT = '2026-10-02T09:00:00.000Z'
const HANDED_AT = '2026-10-03T09:00:00.000Z'

describe('історія позики — лише факти з відповіді API (BS-153)', () => {
  it('новий запит: лише запит і очікувана відповідь, без дати й без позначки завершення', () => {
    const steps = timeline({ status: 'REQUESTED', respondedAt: null, handedAt: null })

    expect(steps.map(({ title }) => title)).toEqual(['Запит надіслано', 'Відповідь власника'])
    expect(steps[0]).toMatchObject({ date: formatDate(REQUESTED_AT), dateTime: REQUESTED_AT })
    expect(steps[1]).toMatchObject({ tone: 'next', date: null })
  })

  it('погоджено: далі — отримання, яке підтверджує позичальник', () => {
    expect(timeline({ status: 'APPROVED', handedAt: null }).at(-1)).toMatchObject({
      tone: 'next',
      title: 'Отримання книжки',
      note: 'Підтверджує позичальник',
      date: null,
    })
  })

  it('на руках: строк — це строк, а не дата повернення', () => {
    const steps = timeline({ dueAt: '2026-11-16' })

    expect(steps.map(({ title }) => title)).toEqual([
      'Запит надіслано',
      'Запит погоджено',
      'Книжку отримано',
      'Повернення',
    ])
    expect(steps.at(-1)).toMatchObject({
      tone: 'next',
      date: null,
      note: `Строк — до ${formatDate('2026-11-16')}`,
    })
  })

  it('прострочення — з серверного isOverdue, позначка без вигаданої дати', () => {
    expect(titles({ isOverdue: true, dueAt: '2026-10-20' })).toContain(
      'alert: Строк повернення минув',
    )
    expect(titles({})).not.toContain('alert: Строк повернення минув')
  })

  it('повернено: дата повернення — returnedAt', () => {
    const returnedAt = '2026-10-25T09:00:00.000Z'

    expect(timeline({ status: 'RETURNED', returnedAt }).at(-1)).toMatchObject({
      title: 'Книжку повернено',
      date: formatDate(returnedAt),
    })
  })

  it('відмова — це відповідь власника, а не погодження', () => {
    expect(titles({ status: 'REJECTED', handedAt: null })).toEqual([
      'done: Запит надіслано',
      'muted: Власник відмовив',
    ])
  })

  it('скасування без дати: API її не зберігає', () => {
    expect(
      timeline({ status: 'CANCELLED', respondedAt: null, handedAt: null }).at(-1),
    ).toMatchObject({ title: 'Запит скасовано', date: null })
    expect(timeline({ status: 'CANCELLED', handedAt: null }).at(-1)?.title).toBe(
      'Домовленість скасовано',
    )
  })

  it('втрата без дати, знахідка — з фактичною датою; статус лишається LOST', () => {
    const effectiveAt = '2026-11-01T00:00:00.000Z'
    const steps = timeline({
      status: 'LOST',
      recovery: { effectiveAt, recordedAt: '2026-11-02T00:00:00.000Z' },
    })

    expect(steps.slice(-2)).toEqual([
      expect.objectContaining({ title: 'Позначено втраченою', date: null, tone: 'alert' }),
      expect.objectContaining({ title: 'Книжка знайшлася', date: formatDate(effectiveAt) }),
    ])
  })

  it('записана власником позика не мала ні запиту, ні погодження', () => {
    const steps = timeline({
      origin: 'RECORDED_EXISTING',
      status: 'PENDING_CONFIRMATION',
      createdAt: '2026-10-05T09:00:00.000Z',
    })

    expect(steps.map(({ title }) => title)).toEqual([
      'Книжку передано',
      'Власник записав позику',
      'Підтвердження позичальника',
    ])
    expect(steps[0]).toMatchObject({ date: formatDate(HANDED_AT), note: 'Дату вказав власник' })
    expect(titles({ origin: 'RECORDED_EXISTING', status: 'HANDED_OVER' })).toContain(
      'done: Позичальник підтвердив запис',
    )
    expect(titles({ origin: 'RECORDED_EXISTING', status: 'DECLINED' })).toContain(
      'muted: Позичальник відхилив запис',
    )
  })

  it('жодна подія не має дати, якої немає у відповіді', () => {
    const facts: Facts = {
      status: 'RETURNED',
      requestedAt: REQUESTED_AT,
      respondedAt: RESPONDED_AT,
      handedAt: null,
      returnedAt: null,
    }

    for (const { dateTime } of timeline(facts)) {
      expect([null, REQUESTED_AT, RESPONDED_AT]).toContain(dateTime)
    }
  })
})
