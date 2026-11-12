import { ApiRequestError } from '@/app/lib/api'
import { loanOf } from '../loans.test-helpers'
import {
  answerFailureText,
  approveLabel,
  ownerTermHint,
  toOwnerRequestView,
} from './owner-request-view'

/** Олесь asks for my «Дюна». */
const REQUEST = loanOf({
  id: 'loan-7',
  side: 'lent',
  title: 'Дюна',
  authors: ['Френк Герберт'],
  status: 'REQUESTED',
  requestedAt: '2026-11-08T12:00:00.000Z',
  respondedAt: null,
  handedAt: null,
  dueAt: '2026-11-29',
  message: 'Хочу перечитати',
  copy: { id: 'copy-loan-7', status: 'AVAILABLE', condition: 'GOOD', isArchived: false },
})

describe('toOwnerRequestView', () => {
  it('shows who asks, for which book and until when — only what the loan carries', () => {
    const view = toOwnerRequestView(REQUEST)

    expect(view.sentLabel).toBe('Надіслано 08.11.26')
    expect(view.borrower).toEqual({
      name: REQUEST.borrower.displayName,
      handle: `@${REQUEST.borrower.handle}`,
      avatarUrl: REQUEST.borrower.avatarUrl,
      href: `/u/${REQUEST.borrower.handle}`,
    })
    expect(view.message).toEqual({ text: 'Хочу перечитати', label: 'Повідомлення · 08.11.26' })
    expect(view.book).toMatchObject({
      id: REQUEST.work.id,
      title: 'Дюна',
      authors: 'Френк Герберт',
      href: `/works/${REQUEST.work.id}`,
      copyState: 'Вдома, вільна',
    })
    expect(view.book.line.startsWith('Френк Герберт')).toBe(true)
    expect(view.requested).toBe('2026-11-29')
    expect(view.outcome).toBeNull()
  })

  it('no message, no date: nothing is made up', () => {
    const view = toOwnerRequestView({ ...REQUEST, message: null, dueAt: null })

    expect(view.message).toBeNull()
    expect(view.requested).toBeNull()
  })

  it('without a request date the creation date is the one sent', () => {
    const view = toOwnerRequestView({
      ...REQUEST,
      requestedAt: null,
      createdAt: '2026-11-05T12:00:00.000Z',
    })

    expect(view.sentLabel).toBe('Надіслано 05.11.26')
  })

  it('approved: the date the loan has now, and the handover still ahead', () => {
    const view = toOwnerRequestView({ ...REQUEST, status: 'APPROVED', dueAt: '2026-12-01' })

    expect(view.requested).toBeNull()
    expect(view.outcome).toEqual({
      tone: 'ok',
      title: 'Запит погоджено',
      text: 'Повернути до 01.12.26. Домовтеся про передачу книжки: отримання підтверджує позичальник.',
      canOpenLoan: true,
    })
  })

  it('approved without a date says so', () => {
    const view = toOwnerRequestView({ ...REQUEST, status: 'APPROVED', dueAt: null })

    expect(view.outcome?.text).toBe(
      'Без дати повернення. Домовтеся про передачу книжки: отримання підтверджує позичальник.',
    )
  })

  it.each([
    ['REJECTED', 'done', 'Запит відхилено', false],
    ['CANCELLED', 'info', 'Запит відкликано', false],
    ['HANDED_OVER', 'info', 'Запит уже опрацьовано', true],
  ] as const)('%s: «%s» outcome «%s»', (status, tone, title, canOpenLoan) => {
    expect(toOwnerRequestView({ ...REQUEST, status }).outcome).toMatchObject({
      tone,
      title,
      canOpenLoan,
    })
  })
})

describe('ownerTermHint', () => {
  it('names the borrower’s date and leaves the last word to the owner', () => {
    expect(ownerTermHint('2026-11-29')).toBe(
      'Позичальник просить до 29.11.26. Остаточну дату повернення вказуєте ви.',
    )
    expect(ownerTermHint(null)).toBe(
      'Позичальник не вказав дату. Оберіть, до якого дня повернути книжку, або залиште без дати.',
    )
  })
})

describe('approveLabel', () => {
  it('names the date the approval agrees to, or that it sets none', () => {
    expect(approveLabel('2026-12-05', false)).toBe('Погодити до 05.12.26')
    expect(approveLabel('', false)).toBe('Погодити без терміну')
  })

  it('while the approval is on its way, says so whatever the date', () => {
    expect(approveLabel('2026-12-05', true)).toBe('Погоджую…')
    expect(approveLabel('', true)).toBe('Погоджую…')
  })
})

describe('answerFailureText', () => {
  it('a refusal tells the server’s reason; anything else, the connection', () => {
    expect(
      answerFailureText(
        new ApiRequestError(409, {
          code: 'LOAN_INVALID_TRANSITION',
          message: 'Запит уже закрито.',
        }),
      ),
    ).toBe(
      'Не вдалося відповісти на запит. Запит уже закрито. Вибрана дата й повідомлення збережені.',
    )
    expect(
      answerFailureText(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'x' })),
    ).toBe(
      'Не вдалося відповісти на запит. Перевірте зʼєднання і спробуйте ще раз. Вибрана дата й повідомлення збережені.',
    )
    expect(answerFailureText(new TypeError('Failed to fetch'))).toBe(
      'Не вдалося відповісти на запит. Перевірте зʼєднання і спробуйте ще раз. Вибрана дата й повідомлення збережені.',
    )
  })
})
