import { LOAN_STATUS, type LoanRole } from '@bookswap/shared'
import { formatDate } from '@/app/lib/labels'
import { loanOf } from '../loans.test-helpers'
import { loanPanelOf } from './loan-panel'

const ROLES: LoanRole[] = ['owner', 'borrower']
const sideOf = (role: LoanRole) => (role === 'owner' ? 'lent' : 'borrowed')
type Facts = Omit<Parameters<typeof loanOf>[0], 'id' | 'side'>

const panel = (role: LoanRole, facts: Facts) =>
  loanPanelOf(loanOf({ id: 'l', side: sideOf(role), ...facts }), role)

describe('інфопанель поточного стану позики (BS-153)', () => {
  it('колір панелі — колір бейджа цього статусу', () => {
    expect(panel('owner', { status: 'REQUESTED' }).tone).toBe('wait')
    expect(panel('owner', { status: 'APPROVED' }).tone).toBe('agreed')
    expect(panel('owner', { status: 'HANDED_OVER' }).tone).toBe('hold')
    expect(
      panel('owner', { status: 'HANDED_OVER', isOverdue: true, dueAt: '2026-10-20' }).tone,
    ).toBe('over')
    expect(panel('owner', { status: 'RETURNED' }).tone).toBe('done')
  })

  it('власник відповідає на запит; бажаний строк позичальника — лише побажання', () => {
    expect(panel('owner', { status: 'REQUESTED', dueAt: '2026-12-01' })).toMatchObject({
      title: 'Олесь просить книжку',
      text: `Бажаний строк — до ${formatDate('2026-12-01')}. Погодьте запит або відмовте; остаточний строк вказуєте ви.`,
    })
  })

  it('після погодження отримання підтверджує позичальник — власник нічого не «передає»', () => {
    expect(panel('owner', { status: 'APPROVED', dueAt: '2026-12-01' }).text).toBe(
      `Отримання книжки підтверджує позичальник. Строк повернення — до ${formatDate('2026-12-01')}.`,
    )
    expect(panel('borrower', { status: 'APPROVED' })).toEqual({
      tone: 'agreed',
      title: 'Запит погоджено',
      text: 'Коли отримаєте книжку, підтвердьте це.',
    })
  })

  it('на руках: строк — погоджена дата; повернення позначає власник', () => {
    expect(panel('borrower', { dueAt: '2026-12-01' }).text).toBe(
      `Поверніть до ${formatDate('2026-12-01')}. Повернення позначає власник, коли отримає книжку.`,
    )
    expect(panel('owner', {}).text).toBe(
      'Строк повернення не вказано. Коли книжка повернеться, позначте це.',
    )
  })

  it('прострочення — за серверною ознакою isOverdue, з датою строку', () => {
    const late = { isOverdue: true, dueAt: '2026-10-20' }

    expect(panel('owner', late)).toMatchObject({
      title: 'Строк повернення минув',
      text: `Книжка мала повернутися до ${formatDate('2026-10-20')}. Коли вона повернеться, позначте це.`,
    })
    expect(panel('borrower', late).title).toBe('Час повернути книжку')
  })

  it('скасування: хто скасував — лише там, де це відомо з даних', () => {
    expect(panel('borrower', { status: 'CANCELLED', respondedAt: null }).title).toBe(
      'Ви скасували запит',
    )
    expect(panel('owner', { status: 'CANCELLED', respondedAt: null }).title).toBe(
      'Позичальник скасував запит',
    )
    expect(panel('owner', { status: 'CANCELLED' }).title).toBe('Домовленість скасовано')
    expect(panel('borrower', { status: 'CANCELLED', origin: 'RECORDED_EXISTING' }).title).toBe(
      'Власник відкликав запис',
    )
  })

  it('завершені позики названо фактом із дати відповіді API або без дати', () => {
    expect(
      panel('owner', { status: 'RETURNED', returnedAt: '2026-10-25T09:00:00.000Z' }).text,
    ).toBe(`Книжку повернено ${formatDate('2026-10-25T09:00:00.000Z')}.`)
    expect(panel('owner', { status: 'RETURNED', returnedAt: null }).text).toBeNull()
    expect(panel('borrower', { status: 'REJECTED' }).text).toBe(
      `Відмовлено ${formatDate('2026-10-02T09:00:00.000Z')}.`,
    )
  })

  it('жодна панель не обіцяє нагадувань, продовження чи сповіщень', () => {
    for (const status of LOAN_STATUS) {
      for (const role of ROLES) {
        for (const isOverdue of [false, true]) {
          const { title, text } = panel(role, { status, isOverdue, dueAt: '2026-10-20' })

          expect(`${title} ${text ?? ''}`).not.toMatch(/нагада|продовж|сповіст|повідом/iu)
        }
      }
    }
  })
})
