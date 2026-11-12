/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { API_ERROR_CODES, LOAN_LIMITS, type ApiErrorCode, type Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { loanOf } from '../loans.test-helpers'
import {
  addDays,
  firstDueDay,
  localDay,
  monthOf,
  movedDay,
  shiftMonth,
  shortDay,
  type Day,
} from '../model/loan-term'
import { BorrowRequestForm, type BorrowRequestFormProps } from './BorrowRequestForm'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const TODAY = localDay(new Date())
const CREATED: Loan = loanOf({
  id: 'loan-new',
  side: 'borrowed',
  title: 'Дюна',
  status: 'REQUESTED',
})

function conflict(code: ApiErrorCode, message = 'Конфлікт'): ApiRequestError {
  return new ApiRequestError(409, { code, message })
}

/** A promise the test settles itself: the request stays «on its way» until then. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

/** The viewport, as `matchMedia` tells it: wide enough for the form under the copy, or a phone. */
let isWide = true
const widthListeners = new Set<() => void>()

function setWide(next: boolean): void {
  isWide = next
  act(() => {
    widthListeners.forEach((notify) => {
      notify()
    })
  })
}

beforeAll(() => {
  window.matchMedia = (media: string) =>
    ({
      get matches() {
        return isWide
      },
      media,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, notify: () => void) => {
        widthListeners.add(notify)
      },
      removeEventListener: (_type: string, notify: () => void) => {
        widthListeners.delete(notify)
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
})

function setup(over: Partial<BorrowRequestFormProps> = {}) {
  const props: BorrowRequestFormProps = {
    copyId: 'copy-1',
    bookTitle: 'Дюна',
    ownerName: 'Марта',
    myLoanId: null,
    expectedReturnAt: null,
    onSettled: jest.fn(() => Promise.resolve()),
    onClose: jest.fn(),
    ...over,
  }

  const view = render(<BorrowRequestForm {...props} />)

  return { ...view, props }
}

const sendButton = () => screen.getByRole('button', { name: 'Надіслати запит' })
const noteField = () => screen.getByRole('textbox', { name: /Повідомлення власнику/ })
const posts = () => apiRequest.mock.calls

beforeEach(() => {
  apiRequest.mockReset()
  isWide = true
})

describe('BorrowRequestForm: «Попросити книжку» for one copy', () => {
  it('an untouched form sends only the copy: no date, no message', async () => {
    apiRequest.mockResolvedValue({ loan: CREATED })
    setup()

    expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent('Без дати')
    expect(screen.getByRole('radio', { name: /^Без дати/ })).toBeChecked()
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('data-term'))).toEqual([
      'none',
      '7',
      '14',
      '21',
      '30',
      'custom',
    ])

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toEqual([
      ['/loans', expect.objectContaining({ method: 'POST', body: { copyId: 'copy-1' } })],
    ])
  })

  it('a preset and a note go into the body, the note trimmed; the counter follows the contract', async () => {
    apiRequest.mockResolvedValue({ loan: CREATED })
    setup()

    await userEvent.click(screen.getByRole('radio', { name: /^3 тижні/ }))
    await userEvent.type(noteField(), '  Хочу перечитати  ')

    expect(noteField()).toHaveAccessibleDescription(`19/${LOAN_LIMITS.messageMax}`)
    expect(noteField()).toHaveAttribute('maxLength', String(LOAN_LIMITS.messageMax))
    expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent(
      shortDay(addDays(TODAY, 21)),
    )

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toEqual([
      [
        '/loans',
        expect.objectContaining({
          method: 'POST',
          body: { copyId: 'copy-1', message: 'Хочу перечитати', proposedDueAt: addDays(TODAY, 21) },
        }),
      ],
    ])
  })

  it('while sending: one POST however often it is pressed, the form locked, «Надсилаю…»', async () => {
    const answer = deferred<{ loan: Loan }>()
    apiRequest.mockReturnValue(answer.promise)
    setup()

    await userEvent.click(sendButton())
    const busy = screen.getByRole('button', { name: 'Надсилаю…' })
    await userEvent.click(busy)
    await userEvent.click(busy)

    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(noteField()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()
    expect(posts()).toHaveLength(1)

    answer.resolve({ loan: CREATED })

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toHaveLength(1)
  })

  it('«Запит надіслано» only after the server created the loan; it opens that request and re-reads the shelf', async () => {
    const answer = deferred<{ loan: Loan }>()
    apiRequest.mockReturnValue(answer.promise)
    const { props } = setup()

    await userEvent.click(sendButton())
    expect(screen.queryByRole('heading', { name: 'Запит надіслано' })).not.toBeInTheDocument()
    expect(props.onSettled).not.toHaveBeenCalled()

    answer.resolve({ loan: CREATED })

    const title = await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(title).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Марта отримає сповіщення і зможе погодити запит, змінивши дату, або відмовити.',
    )
    expect(screen.getByRole('link', { name: 'Відкрити запит' })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-new&role=borrower',
    )
    expect(props.onSettled).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('a failed send keeps the date and the message; a retry sends them again', async () => {
    apiRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props } = setup()

    await userEvent.click(screen.getByRole('radio', { name: /^Тиждень/ }))
    await userEvent.type(noteField(), 'Привіт')
    await userEvent.click(sendButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не вдалося надіслати запит. Перевірте зʼєднання і спробуйте ще раз. Дата й повідомлення збережені.',
    )
    expect(noteField()).toHaveValue('Привіт')
    expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent(
      shortDay(addDays(TODAY, 7)),
    )
    expect(props.onSettled).not.toHaveBeenCalled()

    apiRequest.mockResolvedValueOnce({ loan: CREATED })
    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    const body = { copyId: 'copy-1', message: 'Привіт', proposedDueAt: addDays(TODAY, 7) }
    expect(posts()).toEqual([
      ['/loans', expect.objectContaining({ method: 'POST', body })],
      ['/loans', expect.objectContaining({ method: 'POST', body })],
    ])
  })

  it('a refusal below 500 shows the server message', async () => {
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(400, {
        code: 'VALIDATION_ERROR',
        message: 'Дата має бути в майбутньому.',
      }),
    )
    setup()

    await userEvent.click(sendButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не вдалося надіслати запит. Дата має бути в майбутньому. Дата й повідомлення збережені.',
    )
  })

  it('a duplicate: «Запит уже надіслано», opening the request the re-read shelf knows', async () => {
    apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_DUPLICATE_REQUEST))
    const { props, rerender } = setup()

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит уже надіслано' })
    expect(props.onSettled).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link', { name: 'Відкрити запит' })).not.toBeInTheDocument()

    // The shelf, read again, now carries my open loan on this copy.
    rerender(<BorrowRequestForm {...props} myLoanId="loan-mine" />)

    expect(screen.getByRole('link', { name: 'Відкрити запит' })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-mine&role=borrower',
    )
  })

  it('the copy is no longer free: says so, with «орієнтовно вільна» when the owner set it', async () => {
    apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE))
    const { props } = setup({ expectedReturnAt: '2026-12-01' })

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Книжку зараз не можна попросити' })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Поки ви заповнювали запит, примірник став недоступним. Орієнтовно вільна з 01.12.26.',
    )
    expect(screen.queryByRole('link', { name: 'Відкрити запит' })).not.toBeInTheDocument()
    expect(props.onSettled).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'sent',
      () => apiRequest.mockResolvedValueOnce({ loan: { id: 'loan-1' } }),
      { kind: 'sent', loanId: 'loan-1' },
    ],
    [
      'duplicate',
      () => apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_DUPLICATE_REQUEST)),
      { kind: 'duplicate' },
    ],
    [
      'unavailable',
      () => apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_COPY_UNAVAILABLE)),
      { kind: 'unavailable' },
    ],
    [
      'paused',
      () => apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_REQUESTS_PAUSED)),
      { kind: 'paused' },
    ],
  ])('the shelf is told how the request was settled: %s', async (_, answer, outcome) => {
    answer()
    const { props } = setup()

    await userEvent.click(sendButton())

    await waitFor(() => {
      expect(props.onSettled).toHaveBeenCalledTimes(1)
    })
    expect(props.onSettled).toHaveBeenCalledWith(outcome)
  })

  it('the owner paused requests: says so and offers nothing to open', async () => {
    apiRequest.mockRejectedValueOnce(conflict(API_ERROR_CODES.LOAN_REQUESTS_PAUSED))
    setup()

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Власник зараз не приймає запитів' })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Марта тимчасово не приймає запитів на позичання. Спробуйте пізніше.',
    )
    expect(screen.queryByRole('link', { name: 'Відкрити запит' })).not.toBeInTheDocument()
  })

  it('«Скасувати» closes without a request', async () => {
    const { props } = setup()

    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(posts()).toHaveLength(0)
    })
  })
})

/** The `aria-label` of a calendar day: its date, and «обрана дата» once chosen. */
const dayButton = (day: Day) =>
  screen.getByRole('button', { name: new RegExp(`^${shortDay(day)}`) })

describe('BorrowRequestForm: the calendar months ahead', () => {
  it('«Наступний місяць» four times, a day there; «Попередній» back to this month and no further', async () => {
    apiRequest.mockResolvedValue({ loan: CREATED })
    setup()
    const next = screen.getByRole('button', { name: 'Наступний місяць' })
    const previous = screen.getByRole('button', { name: 'Попередній місяць' })
    const ahead = shiftMonth(monthOf(TODAY), 4)
    const chosen: Day = `${String(ahead.year)}-${String(ahead.month + 1).padStart(2, '0')}-15`

    expect(previous).toBeDisabled()
    for (let step = 0; step < 4; step += 1) await userEvent.click(next)

    await userEvent.click(dayButton(chosen))

    expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent(shortDay(chosen))
    expect(screen.getByRole('radio', { name: /^Своя дата/ })).toBeChecked()

    for (let step = 0; step < 4; step += 1) await userEvent.click(previous)
    expect(previous).toBeDisabled()

    await userEvent.click(sendButton())
    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toEqual([
      ['/loans', expect.objectContaining({ body: { copyId: 'copy-1', proposedDueAt: chosen } })],
    ])
  })

  it('PageDown moves the day a month at a time, past the end of the year; Enter chooses it', async () => {
    setup()
    const days = screen.getByRole('group', { name: 'Дата повернення' })
    let expected = firstDueDay(TODAY)

    // Tab stop of an empty calendar: the first day that can be chosen.
    within(days)
      .getByRole('button', { name: new RegExp(`^${shortDay(expected)}`) })
      .focus()
    for (let step = 0; step < 3; step += 1) {
      await userEvent.keyboard('{PageDown}')
      expected = movedDay(expected, 'PageDown') ?? expected
      expect(dayButton(expected)).toHaveFocus()
    }
    await userEvent.keyboard('{Enter}')

    expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent(
      shortDay(expected),
    )
    expect(dayButton(expected)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('BorrowRequestForm: a phone gets a bottom sheet', () => {
  it('narrower than 48rem: the form opens as the dialog «Попросити книжку», naming the book', () => {
    isWide = false
    setup()

    const sheet = screen.getByRole('dialog', { name: 'Попросити книжку' })

    expect(sheet).toHaveAccessibleDescription('Дюна')
    expect(within(sheet).getByRole('button', { name: 'Надіслати запит' })).toBeInTheDocument()
  })

  it('Escape closes the sheet, but not while the request is on its way', async () => {
    const answer = deferred<{ loan: Loan }>()
    apiRequest.mockReturnValue(answer.promise)
    isWide = false
    const { props } = setup()

    await userEvent.click(sendButton())
    await userEvent.keyboard('{Escape}')
    expect(props.onClose).not.toHaveBeenCalled()

    answer.resolve({ loan: CREATED })
    await screen.findByRole('heading', { name: 'Запит надіслано' })
    await userEvent.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('turning the phone keeps the note, the date and the failure, both ways', async () => {
    apiRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    setup()

    await userEvent.click(screen.getByRole('radio', { name: /^2 тижні/ }))
    await userEvent.type(noteField(), 'Привіт')
    await userEvent.click(sendButton())
    await screen.findByRole('alert')

    const kept = () => {
      expect(noteField()).toHaveValue('Привіт')
      expect(screen.getByRole('group', { name: 'Повернути до' })).toHaveTextContent(
        shortDay(addDays(TODAY, 14)),
      )
      expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося надіслати запит.')
    }

    setWide(false)
    expect(screen.getByRole('dialog', { name: 'Попросити книжку' })).toBeInTheDocument()
    kept()

    setWide(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    kept()
  })
})
